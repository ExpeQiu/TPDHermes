"""Render a GEO card from confirmed, public facts."""

from typing import Any
from urllib.parse import urlsplit

from backend.services.skill_loader import Skill

FIELDS = {
    "tech_name": "技术名称",
    "audience_scene": "用户与场景",
    "selling_points": "用户收益与卖点",
    "mechanism": "技术机理",
    "quantified_data": "量化数据",
    "conditions": "测试条件",
    "vehicle_scope": "搭载范围",
    "public_wording": "公开口径",
    "comparison": "对照证据",
}


class GeoCardSkill(Skill):
    @property
    def name(self) -> str:
        return "geo_card_skill"

    def validate_input(self, input_data: Any) -> bool:
        return isinstance(input_data, dict) and isinstance(input_data.get("facts"), list)

    def generate(self, context: dict) -> dict:
        lines = ["# GEO结构化信息卡"]
        for key, label in FIELDS.items():
            lines.extend(["", f"## {label}"])
            entries = []
            for fact in context.get("facts", []):
                if not isinstance(fact, dict) or fact.get("visibility") != "public" or fact.get("claim") != key:
                    continue
                value = str(fact.get("value") or "").strip()
                if not value:
                    continue
                unit = str(fact.get("unit") or "").strip()
                conditions = str(fact.get("conditions") or "").strip()
                entry = f"- {value}"
                if unit:
                    entry += f" {unit}"
                if conditions:
                    entry += f"（适用条件：{conditions}）"
                source = str(fact.get("source_ref") or "")
                try:
                    parsed = urlsplit(source)
                except ValueError:
                    parsed = None
                if parsed and parsed.scheme in {"https", "http"} and parsed.hostname:
                    entry += f"\n  - 公开来源：{source}"
                entries.append(entry)
            lines.extend(entries or ["待补充"])
        return {"skill": self.name, "content": "\n".join(lines) + "\n"}
