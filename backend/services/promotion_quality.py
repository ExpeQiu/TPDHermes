"""推广包资料评估、事实指纹与出品阻塞规则。"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

TEMPLATE_VERSION = "2026-11-17"
GEO_PRODUCT = "geo_card_skill"
# 发言稿、领导讲稿、短视频脚本、导演脚本需多轮成稿，不走技术推广包。
RETIRED_PRODUCTS = frozenset(
    {
        "speech_skill",
        "speech_draft_skill",
        "video_skill",
        "video_script_skill",
    }
)
PRODUCTS = (
    "a4_skill",
    "tech_pr_skill",
    "interview_qa_skill",
    "sales_skill",
    GEO_PRODUCT,
)
_COMMON = list(PRODUCTS)
PRODUCT_TITLES = {
    "a4_skill": "A4技术一页纸",
    "tech_pr_skill": "技术通稿",
    "interview_qa_skill": "采访QA",
    "speech_skill": "发言稿",
    "speech_draft_skill": "领导讲稿",
    "video_skill": "短视频脚本",
    "video_script_skill": "导演脚本",
    "sales_skill": "销售话术",
    "material_skill": "传播素材清单",
    GEO_PRODUCT: "GEO结构化信息卡",
}
PRODUCT_FILES = {
    "a4_skill": "A4技术一页纸.md",
    "tech_pr_skill": "技术通稿.md",
    "interview_qa_skill": "采访QA.md",
    "speech_skill": "发言稿.md",
    "speech_draft_skill": "领导讲稿.md",
    "video_skill": "短视频脚本.md",
    "video_script_skill": "导演脚本.md",
    "sales_skill": "销售话术.md",
    "material_skill": "传播素材清单.md",
    GEO_PRODUCT: "GEO结构化信息卡.md",
}

FIELDS: list[dict[str, Any]] = [
    {"key": "tech_name", "label": "技术名称", "required_for": _COMMON},
    {"key": "audience_scene", "label": "用户与场景", "required_for": _COMMON},
    {"key": "selling_points", "label": "卖点", "required_for": _COMMON},
    {"key": "mechanism", "label": "机理", "required_for": ["a4_skill", "tech_pr_skill"]},
    {"key": "quantified_data", "label": "量化数据", "required_for": ["a4_skill", "tech_pr_skill"]},
    {"key": "conditions", "label": "条件", "required_for": ["a4_skill", "tech_pr_skill"]},
    {"key": "vehicle_scope", "label": "搭载范围", "required_for": ["a4_skill"]},
    {"key": "public_wording", "label": "可公开口径", "required_for": _COMMON},
    {"key": "comparison", "label": "对比", "required_for": ["interview_qa_skill"]},
]
FIELD_BY_KEY = {item["key"]: item for item in FIELDS}
LABEL_TO_KEY = {item["label"]: item["key"] for item in FIELDS}
LABEL_TO_KEY.update({item["key"]: item["key"] for item in FIELDS})
_MISSING = {"", "待补充", "待联网", "缺失", "无", "暂无", "-"}
_LINE = re.compile(r"^\s*([^:：]{1,20})\s*[:：]\s*(.+?)\s*$")


def corpus_token(brief_version: int, facts_version: int) -> str:
    return f"b{int(brief_version)}-f{int(facts_version)}"


def is_placeholder(value: str) -> bool:
    text = (value or "").strip()
    if text in _MISSING:
        return True
    return "待补充" in text or "待联网" in text


def _pairs(blob: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in (blob or "").split():
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        found[key.strip()] = raw.strip()
    return found


def _payload(line: str) -> str:
    for sep in ("：", ":"):
        if sep in line:
            return line.split(sep, 1)[1].strip()
    return line


def parse_material(content: str) -> dict[str, Any]:
    """从资料正文抽取字段，以及知识库 / 联网候选。候选不自动成为事实。"""
    values: dict[str, list[str]] = {}
    candidates: list[dict[str, str]] = []
    for raw_line in (content or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("知识库证据"):
            pairs = _pairs(_payload(line))
            candidates.append(
                {
                    "origin": "kb",
                    "claim": LABEL_TO_KEY.get(pairs.get("claim", ""), pairs.get("claim", "")),
                    "value": pairs.get("value", ""),
                    "doc_id": pairs.get("doc_id", ""),
                    "locator": pairs.get("locator", ""),
                    "url": "",
                }
            )
            continue
        if line.startswith("联网线索"):
            pairs = _pairs(_payload(line))
            candidates.append(
                {
                    "origin": "web",
                    "claim": LABEL_TO_KEY.get(pairs.get("claim", ""), pairs.get("claim", "")),
                    "value": pairs.get("value", ""),
                    "doc_id": "",
                    "locator": pairs.get("url", ""),
                    "url": pairs.get("url", ""),
                }
            )
            continue
        matched = _LINE.match(line)
        if not matched:
            continue
        key = LABEL_TO_KEY.get(matched.group(1).strip())
        if not key:
            continue
        values.setdefault(key, []).append(matched.group(2).strip())
    return {"values": values, "candidates": candidates}


def assess_documents(
    documents: list[dict[str, Any]],
    *,
    selected: list[str],
) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, str]]] = {}
    candidates: list[dict[str, Any]] = []
    unreadable: list[dict[str, str]] = []
    for doc in documents:
        if doc.get("parse_status") != "ok":
            unreadable.append(
                {
                    "file_id": str(doc.get("file_id") or ""),
                    "title": str(doc.get("title") or ""),
                    "reason": str(doc.get("parse_error") or "解析失败"),
                }
            )
            continue
        parsed = parse_material(str(doc.get("content") or ""))
        for key, found in parsed["values"].items():
            for value in found:
                grouped.setdefault(key, []).append(
                    {
                        "value": value,
                        "file_id": str(doc.get("file_id") or ""),
                        "version": str(doc.get("version") or ""),
                        "title": str(doc.get("title") or ""),
                    }
                )
        for item in parsed["candidates"]:
            if not item.get("claim") or not item.get("value"):
                continue
            candidates.append(
                {
                    "origin": item["origin"],
                    "claim": item["claim"],
                    "value": item["value"],
                    "visibility": "public",
                    "source": {
                        "doc_id": item.get("doc_id") or "",
                        "locator": item.get("locator") or "",
                        "url": item.get("url") or "",
                        "file_id": str(doc.get("file_id") or ""),
                    },
                }
            )
    fields: list[dict[str, Any]] = []
    for spec in FIELDS:
        hits = grouped.get(spec["key"], [])
        usable = [hit for hit in hits if not is_placeholder(hit["value"])]
        distinct = []
        for hit in usable:
            if hit["value"] not in distinct:
                distinct.append(hit["value"])
        blocks = [name for name in spec["required_for"] if name in selected]
        if len(distinct) > 1:
            status = "conflict"
            reason = "同一字段出现不同取值"
        elif len(distinct) == 1:
            status = "present"
            reason = ""
        else:
            status = "missing"
            reason = "资料中没有可用取值"
        fields.append(
            {
                "key": spec["key"],
                "label": spec["label"],
                "status": status,
                "reason": reason,
                "blocks": blocks if status in {"missing", "conflict"} else [],
                "evidence": [
                    {
                        "file_id": hit["file_id"],
                        "version": hit["version"],
                        "locator": spec["label"],
                        "excerpt": hit["value"][:80],
                    }
                    for hit in usable
                ],
            }
        )
    if unreadable:
        fields.append(
            {
                "key": "parse",
                "label": "文件解析",
                "status": "unreadable",
                "reason": "、".join(item["title"] or item["file_id"] for item in unreadable),
                "blocks": [],
                "evidence": [
                    {"file_id": item["file_id"], "version": "", "locator": "file", "excerpt": item["reason"][:80]}
                    for item in unreadable
                ],
            }
        )
    blocked = sorted({name for field in fields for name in field["blocks"]})
    return {"fields": fields, "candidates": candidates, "blocked_products": blocked}


def gap_fields(fields: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        field
        for field in fields
        if field.get("status") in {"missing", "conflict"} and field.get("key") != "parse"
    ]


def suggest_from_project_docs(
    documents: list[dict[str, Any]],
    fields: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """在项目资料正文里为缺口找可核对的短句。结果只作候选，不直接成为事实。"""
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for field in gap_fields(fields):
        label = str(field.get("label") or "")
        key = str(field.get("key") or "")
        if not label:
            continue
        for doc in documents:
            if doc.get("parse_status") != "ok":
                continue
            for raw in str(doc.get("content") or "").splitlines():
                line = raw.strip()
                if not line or label not in line:
                    continue
                value = line
                head, sep, tail = line.partition("：")
                if not sep:
                    head, sep, tail = line.partition(":")
                if sep and label in head:
                    value = tail.strip()
                value = value.strip()
                if is_placeholder(value):
                    continue
                value = value[:160]
                token = (key, value)
                if token in seen:
                    continue
                seen.add(token)
                found.append(
                    {
                        "origin": "project",
                        "claim": key,
                        "value": value,
                        "needs_confirm": True,
                        "source": {
                            "doc_id": "",
                            "locator": str(doc.get("title") or ""),
                            "url": "",
                            "file_id": str(doc.get("file_id") or ""),
                        },
                    }
                )
                break
    return found


def mark_gap_attention(fields: list[dict[str, Any]], candidates: list[dict[str, Any]]) -> None:
    covered = {str(item.get("claim") or "") for item in candidates if str(item.get("value") or "").strip()}
    for field in fields:
        status = field.get("status")
        key = str(field.get("key") or "")
        if status == "conflict" or (status == "missing" and key in covered):
            field["attention"] = "confirm"
        elif status == "missing":
            field["attention"] = "fill"
        else:
            field["attention"] = ""


def public_gap_query(fields: list[dict[str, Any]], label: str) -> str:
    """联网检索词只用可公开称呼，不带内部实测数字。"""
    base = build_search_query(fields)
    if base == "公开技术对比":
        return f"公开技术 {label}".strip()
    return f"{base} {label}".strip()


def build_search_query(fields: list[dict[str, Any]]) -> str:
    """检索词只用可公开信息，不带内部参数。"""
    by_key = {field["key"]: field for field in fields}
    public = ""
    for item in by_key.get("public_wording", {}).get("evidence") or []:
        public = str(item.get("excerpt") or "")
        break
    tech = ""
    for item in by_key.get("tech_name", {}).get("evidence") or []:
        tech = str(item.get("excerpt") or "")
        break
    if "可对外" in public and tech:
        return tech
    return "公开技术对比"


_WIKI_SECTIONS = (
    ("技术定义与定位", {"tech_name", "selling_points", "public_wording"}),
    ("工作机制与核心能力", {"mechanism"}),
    ("核心指标", {"quantified_data", "conditions", "comparison"}),
    ("应用与场景", {"audience_scene", "vehicle_scope"}),
)


def wiki_page(facts: list[dict[str, Any]], *, goal: str = "", audience: str = "") -> dict[str, Any]:
    """按技术页结构收成 claims。占位和空值不进入，条件紧挨结论。"""
    claims: list[dict[str, Any]] = []
    for fact in facts:
        value = str(fact.get("value") or "").strip()
        claim_key = str(fact.get("claim") or "")
        if not value or is_placeholder(value) or claim_key not in FIELD_BY_KEY:
            continue
        label = FIELD_BY_KEY[claim_key]["label"]
        statement = value if value.startswith(label) else f"{label}：{value}"
        visibility = "public" if str(fact.get("visibility") or "") == "public" else "project"
        claims.append(
            {
                "id": str(fact.get("id") or claim_key),
                "claim": claim_key,
                "statement": statement,
                "conditions": str(fact.get("conditions") or "").strip(),
                "source": " ".join(
                    part
                    for part in (str(fact.get("source_type") or ""), str(fact.get("source_ref") or ""))
                    if part
                ),
                "usage": "current" if visibility == "public" else "internal",
            }
        )
    by_key = {item["claim"]: item for item in claims}
    sections = []
    for heading, keys in _WIKI_SECTIONS:
        lines = []
        for key in keys:
            item = by_key.get(key)
            if not item:
                continue
            line = item["statement"]
            if item["conditions"]:
                line = f"{line}（{item['conditions']}）"
            lines.append(line)
        if lines:
            sections.append({"heading": heading, "body": "\n".join(lines)})
    title = ""
    if "tech_name" in by_key:
        title = by_key["tech_name"]["statement"].split("：", 1)[-1]
    return {
        "type": "product",
        "title": title,
        "goal": goal.strip(),
        "audience": audience.strip(),
        "summary": sections[0]["body"].split("\n", 1)[0] if sections else "",
        "sections": sections,
        "claims": claims,
    }


def blocked_by_facts(facts: list[dict[str, Any]], selected: list[str]) -> list[dict[str, Any]]:
    blocked: list[dict[str, Any]] = []
    for product in selected:
        present = {
            str(fact.get("claim") or "")
            for fact in facts
            if (product != GEO_PRODUCT or fact.get("visibility") == "public")
            and not is_placeholder(str(fact.get("value") or ""))
        }
        spec = [item["key"] for item in FIELDS if product in item["required_for"]]
        missing = [key for key in spec if key not in present]
        if missing:
            blocked.append({"product": product, "missing": missing})
    return blocked


def brief_fingerprint(brief: dict[str, Any]) -> str:
    raw = json.dumps(
        {"goal": brief.get("goal") or "", "audience": brief.get("audience") or ""},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def fact_fingerprint(facts: list[dict[str, Any]], fact_ids: list[str]) -> str:
    wanted = set(fact_ids)
    rows = []
    for fact in facts:
        if str(fact.get("id") or "") not in wanted:
            continue
        rows.append(
            {
                "id": fact.get("id"),
                "claim": fact.get("claim"),
                "value": fact.get("value"),
                "unit": fact.get("unit") or "",
                "conditions": fact.get("conditions") or "",
                "visibility": fact.get("visibility") or "project",
            }
        )
    rows.sort(key=lambda item: str(item["id"]))
    raw = json.dumps(rows, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def changed_fact_ids(previous: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[str]:
    old = {str(item.get("id")): fact_fingerprint([item], [str(item.get("id"))]) for item in previous if item.get("id")}
    new = {str(item.get("id")): fact_fingerprint([item], [str(item.get("id"))]) for item in current if item.get("id")}
    changed = [fact_id for fact_id, digest in old.items() if new.get(fact_id) != digest]
    return sorted(changed)


def skill_context(product: str, facts: list[dict[str, Any]], brief: dict[str, Any]) -> dict[str, Any]:
    if product == GEO_PRODUCT:
        return {"facts": [fact for fact in facts if fact.get("visibility") == "public"]}
    context = _skill_context(product, facts, brief)
    wiki = brief.get("wiki") if isinstance(brief.get("wiki"), dict) else {}
    context["wiki_claims"] = [
        item.get("statement")
        for item in wiki.get("claims") or []
        if isinstance(item, dict) and item.get("statement")
    ]
    return context


def _skill_context(product: str, facts: list[dict[str, Any]], brief: dict[str, Any]) -> dict[str, Any]:
    by_claim = {str(fact.get("claim")): fact for fact in facts}
    def value(key: str) -> str:
        return str((by_claim.get(key) or {}).get("value") or "")

    tech = value("tech_name") or "未命名技术"
    if product == "a4_skill":
        return {
            "tech_name": tech,
            "slogan": value("selling_points"),
            "scene_benefits": [{"scene": value("audience_scene"), "benefit": value("selling_points")}],
            "tech_highlights": [
                {
                    "highlight": "机理",
                    "params": value("mechanism"),
                    "user_benefit": value("selling_points"),
                }
            ],
            "test_data": [{"data": value("quantified_data"), "source": value("conditions")}],
            "vehicle_models": [
                {"model": value("vehicle_scope"), "plan": "见搭载范围", "rights": value("public_wording")}
            ],
        }
    if product == "tech_pr_skill":
        return {"topic": tech, "type": "技术通稿"}
    if product == "speech_skill":
        return {
            "tech_name": tech,
            "slogan": value("selling_points"),
            "scene_pain": value("audience_scene"),
            "tech_solution": value("mechanism") or value("selling_points"),
            "user_value": value("selling_points"),
            "cta": value("public_wording") or str(brief.get("goal") or ""),
        }
    if product == "speech_draft_skill":
        return {
            "occasion": str(brief.get("goal") or "技术发布"),
            "speaker": str(brief.get("audience") or "项目发言人"),
            "topic": tech,
        }
    if product == "video_skill":
        return {
            "theme": tech,
            "tech_name": tech,
            "hook": value("audience_scene"),
            "tech_display": value("mechanism") or value("selling_points"),
            "scene_demo": value("audience_scene"),
            "evidence": value("quantified_data"),
            "cta": value("public_wording"),
        }
    if product == "video_script_skill":
        return {"product": tech, "topic": tech, "duration": "60秒", "platform": "短视频平台"}
    if product == "sales_skill":
        return {
            "tech_name": tech,
            "tech_brand": tech,
            "vehicle_model": value("vehicle_scope") or "目标车型",
            "top_selling_points": [value("selling_points")] if value("selling_points") else [],
        }
    return {"topic": tech, "spokesperson": str(brief.get("audience") or "项目发言人")}


def cited_fact_ids(product: str, facts: list[dict[str, Any]]) -> list[str]:
    if product == GEO_PRODUCT:
        return [str(fact["id"]) for fact in facts if fact.get("id") and fact.get("visibility") == "public" and fact.get("claim") in FIELD_BY_KEY]
    required = [item["key"] for item in FIELDS if product in item["required_for"]]
    by_claim = {str(fact.get("claim")): str(fact.get("id")) for fact in facts if fact.get("id")}
    return [by_claim[key] for key in required if key in by_claim]


def append_citations(content: str, facts: list[dict[str, Any]], fact_ids: list[str]) -> str:
    wanted = set(fact_ids)
    lines = ["", "## 引用事实"]
    for fact in facts:
        if str(fact.get("id")) not in wanted:
            continue
        lines.append(
            f"- {fact.get('id')}: {fact.get('claim')} = {fact.get('value')}（{fact.get('conditions') or '无附加条件'}）"
        )
    return (content or "").rstrip() + "\n" + "\n".join(lines) + "\n"


def invalidate_products(
    products: dict[str, Any],
    *,
    changed_ids: list[str],
    brief_changed: bool,
) -> dict[str, Any]:
    changed = set(changed_ids)
    for state in products.values():
        versions = state.get("versions") or []
        for version in versions:
            cites = set(version.get("fact_ids") or [])
            if brief_changed or cites & changed:
                if version.get("status") == "approved":
                    version["status"] = "needs_rereview"
        head_id = state.get("head_output_id") or ""
        head = next((item for item in versions if item.get("output_id") == head_id), None)
        if head:
            state["status"] = head.get("status") or state.get("status")
    return products


def safe_zip_name(name: str) -> str:
    base = (name or "output.md").replace("\\", "/").split("/")[-1]
    cleaned = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", base).strip("._")
    return cleaned or "output.md"
