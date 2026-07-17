"""轨迹写盘（方法论 §五）。"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass
class Delivery:
    title: str
    body_markdown: str
    artifacts: list[Any] = field(default_factory=list)


@dataclass
class RunResult:
    run_id: str
    module: str
    mode: str
    coordinator: str
    delivery: Delivery
    data_source: str
    version: str = "0.1.0"
    fetched_at: str = field(default_factory=_now_iso)
    warnings: list[str] = field(default_factory=list)
    status: str = "completed"
    meta: dict[str, Any] = field(default_factory=dict)

    def to_envelope(self) -> dict[str, Any]:
        return {
            "module": self.module,
            "version": self.version,
            "data_source": self.data_source,
            "fetched_at": self.fetched_at,
            "run_id": self.run_id,
            "mode": self.mode,
            "coordinator": self.coordinator,
            "status": self.status,
            "delivery": {
                "title": self.delivery.title,
                "body_markdown": self.delivery.body_markdown,
                "artifacts": self.delivery.artifacts,
            },
            "warnings": self.warnings,
            "meta": self.meta,
        }


class TrajectoryStore:
    def __init__(self, runs_dir: str | Path = "runs") -> None:
        self.root = Path(runs_dir)
        self.root.mkdir(parents=True, exist_ok=True)

    def new_run_id(self) -> str:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        return f"{ts}-{uuid.uuid4().hex[:8]}"

    def run_dir(self, run_id: str) -> Path:
        path = self.root / run_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def append_event(
        self,
        run_id: str,
        event_type: str,
        *,
        task: str = "",
        actor: str = "",
        inputs: Optional[list[str]] = None,
        outputs: Optional[list[str]] = None,
        notes: str = "",
        metrics: Optional[dict[str, Any]] = None,
    ) -> None:
        d = self.run_dir(run_id)
        traj = d / "trajectory.md"
        block = [
            f"## [{_now_iso()}] {event_type}",
            "",
            f"**{event_type}**",
            "",
            "### 任务",
            task or "-",
            "",
            "### 执行者",
            actor or "-",
            "",
            "### 关键输入",
        ]
        for item in inputs or []:
            block.append(f"- {item}")
        if not inputs:
            block.append("- -")
        block.extend(["", "### 关键输出"])
        for item in outputs or []:
            block.append(f"- {item}")
        if not outputs:
            block.append("- -")
        block.extend(["", "### 效率指标"])
        if metrics:
            for k, v in metrics.items():
                block.append(f"- {k}：{v}")
        else:
            block.append("- -")
        block.extend(["", "### 备注", notes or "-", "", ""])
        with traj.open("a", encoding="utf-8") as f:
            f.write("\n".join(block))

    def save_result(self, result: RunResult) -> Path:
        d = self.run_dir(result.run_id)
        envelope_path = d / "result.json"
        envelope_path.write_text(
            json.dumps(result.to_envelope(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (d / "delivery.md").write_text(result.delivery.body_markdown, encoding="utf-8")
        state = {
            "run_id": result.run_id,
            "status": result.status,
            "mode": result.mode,
            "module": result.module,
            "updated_at": _now_iso(),
            "resume_token": result.meta.get("resume_token"),
        }
        (d / "state.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return envelope_path

    def load_result(self, run_id: str) -> Optional[dict[str, Any]]:
        path = self.root / run_id / "result.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def load_state(self, run_id: str) -> Optional[dict[str, Any]]:
        path = self.root / run_id / "state.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def load_trajectory(self, run_id: str) -> str:
        path = self.root / run_id / "trajectory.md"
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    def list_runs(self) -> list[dict[str, Any]]:
        """运行摘要列表（新→旧，按目录名排序）。"""
        if not self.root.is_dir():
            return []
        items: list[dict[str, Any]] = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            result: dict[str, Any] = {}
            if (d / "result.json").is_file():
                result = json.loads((d / "result.json").read_text(encoding="utf-8"))
            elif (d / "state.json").is_file():
                result = json.loads((d / "state.json").read_text(encoding="utf-8"))
            delivery = result.get("delivery") or {}
            items.append(
                {
                    "id": d.name,
                    "mode": result.get("mode", "?"),
                    "status": result.get("status", "?"),
                    "title": delivery.get("title", "") if isinstance(delivery, dict) else "",
                }
            )
        return items

    def load_bundle(self, run_id: str) -> Optional[dict[str, Any]]:
        """完整 run 包：envelope + delivery 正文 + trajectory。"""
        d = self.root / run_id
        if not d.is_dir():
            return None
        envelope: dict[str, Any] = {}
        if (d / "result.json").is_file():
            envelope = json.loads((d / "result.json").read_text(encoding="utf-8"))
        delivery = ""
        if (d / "delivery.md").is_file():
            delivery = (d / "delivery.md").read_text(encoding="utf-8")
        traj = self.load_trajectory(run_id)
        if not delivery:
            body = (envelope.get("delivery") or {}).get("body_markdown", "")
            delivery = body if isinstance(body, str) else ""
        return {
            "envelope": envelope,
            "delivery": delivery,
            "trajectory": traj,
        }

    def mark_resumable(self, run_id: str, resume_token: str, mode: str, module: str) -> None:
        d = self.run_dir(run_id)
        state = {
            "run_id": run_id,
            "status": "paused",
            "mode": mode,
            "module": module,
            "updated_at": _now_iso(),
            "resume_token": resume_token,
        }
        (d / "state.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
        )
