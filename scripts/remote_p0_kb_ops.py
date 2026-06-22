#!/usr/bin/env python3
"""远程 P0 运维：禁用缺失技能、重灌 remote_debug、repair 关键 Chroma 集合。"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path("/app") if Path("/app/backend").is_dir() else Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

REMOTE_DEBUG_CONTENT = """
## 服务入口
- 公网地址: http://47.113.225.93:8033
- 健康检查: GET /health
- 对话配置: GET /api/v1/chat/config
- 对话代理: POST /api/v1/chat/completions

## 服务拓扑
nginx -> frontend -> backend (tphermes-backend) -> hermes-agent -> tphermes-mcp -> chroma

## MCP 知识库验证
Agent 可通过 mcp_tphermes_kb_query 查询集合 public.structured_tech.remote_debug。
验收关键词: 8033、远程联调、health、MCP。

## 增量部署原则
- 日常勿整体 docker compose up --build 全服务
- 仅修改 backend/frontend/skills 时只构建对应镜像
- hermes-agent 镜像构建耗时长，非必要不重建

## Chroma
- 内网地址: http://chroma:8000
- embedding 模型: BAAI/bge-small-zh-v1.5
""".strip()

KEY_COLLECTIONS = [
    "internal.structured_tech.tech_points",
    "public.release_assets.speeches",
    "public.structured_tech.geely_tech",
    "public.internal_methodology.tpd_experience",
    "public.public_intel.auto_company_strategy",
    "public.public_intel.vehicle_model_library",
    "bilibili_video_analysis",
    "public.structured_tech.remote_debug",
]

DISABLE_SKILL = "tech_trend_skill__auto_e673e6c"


def disable_missing_skill(db_path: str) -> dict:
    conn = sqlite3.connect(db_path)
    cur = conn.execute(
        "UPDATE skills SET enabled=0 WHERE name=?",
        (DISABLE_SKILL,),
    )
    conn.commit()
    row = conn.execute(
        "SELECT name, enabled FROM skills WHERE name=?",
        (DISABLE_SKILL,),
    ).fetchone()
    conn.close()
    return {
        "skill": DISABLE_SKILL,
        "row": list(row) if row else None,
        "rows_updated": cur.rowcount,
    }


async def ingest_remote_debug() -> dict:
    from backend.services.kb_write import add_kb_harvest_entry

    result = await add_kb_harvest_entry(
        collection_name="public.structured_tech.remote_debug",
        project_id="__all__",
        title="8033 远程联调文档",
        content=REMOTE_DEBUG_CONTENT,
        summary="TPDHermes 阿里云 8033 端口远程联调验收文档",
        domain="structured_tech",
        source="ops_remote_debug",
        published=True,
        metadata={"harvested_from_user_confirmed": True, "created_by": "ops"},
    )
    out = {k: v for k, v in result.items() if k != "_sync"}
    return out


def repair_collections(chroma_url: str, collections: list[str]) -> list[dict]:
    import importlib.util

    repair_path = ROOT / "scripts" / "kb_repair_chroma_collection.py"
    spec = importlib.util.spec_from_file_location("kb_repair", repair_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 repair 脚本: {repair_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    repair_fn = mod.repair_chroma_collection

    reports: list[dict] = []
    for col in collections:
        print(f"[repair] start {col}", flush=True)
        try:
            report = repair_fn(
                chroma_url=chroma_url,
                collection=col,
                batch_size=64,
                dry_run=False,
            )
            reports.append(report)
            print(f"[repair] ok {col}: {report}", flush=True)
        except Exception as e:
            err = {"collection": col, "status": "failed", "error": str(e)}
            reports.append(err)
            print(f"[repair] fail {col}: {e}", flush=True)
    return reports


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/app/data/tphermes.db")
    parser.add_argument("--chroma-url", default="http://chroma:8000")
    parser.add_argument("--skip-disable", action="store_true")
    parser.add_argument("--skip-ingest", action="store_true")
    parser.add_argument("--skip-repair", action="store_true")
    args = parser.parse_args()

    summary: dict = {}

    if not args.skip_disable:
        summary["disable_skill"] = disable_missing_skill(args.db)
        print(json.dumps(summary["disable_skill"], ensure_ascii=False), flush=True)

    if not args.skip_ingest:
        summary["ingest"] = asyncio.run(ingest_remote_debug())
        print(json.dumps(summary["ingest"], ensure_ascii=False), flush=True)

    if not args.skip_repair:
        summary["repair"] = repair_collections(args.chroma_url, KEY_COLLECTIONS)
        print(json.dumps(summary["repair"], ensure_ascii=False), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
