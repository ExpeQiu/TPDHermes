"""
A4Skill - A4技术规格文档生成

基于模板文件生成标准A4格式技术文档。
模板结构：技术名/Slogan → 场景收益 → 技术亮点 → 实测数据 → 车型权益
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    tech_name = ctx.get("tech_name", "未命名技术")
    slogan = ctx.get("slogan", "")
    scene_benefits = ctx.get("scene_benefits", [])
    highlights = ctx.get("tech_highlights", [])
    test_data = ctx.get("test_data", [])
    vehicles = ctx.get("vehicle_models", [])

    # 基础字段
    text = text.replace("[技术名]", tech_name)
    text = text.replace("Slogan（一句话承诺）", slogan)
    text = text.replace("**[技术名]**", f"**{tech_name}**")

    # 场景收益行
    lines = text.split('\n')
    si = 0
    for i, line in enumerate(lines):
        if re.match(r"│  · 场景\d+：收益\d+", line):
            if si < len(scene_benefits):
                s = scene_benefits[si]
                lines[i] = f"│  · {s.get('scene', '')}：{s.get('benefit', '')}"
            else:
                lines[i] = "│"
            si += 1
    text = '\n'.join(lines)

    # 技术亮点行
    lines = text.split('\n')
    hi = 0
    for i, line in enumerate(lines):
        if re.match(r"│  · 亮点\d+：参数/原理 → 用户收益", line):
            if hi < len(highlights):
                h = highlights[hi]
                lines[i] = (f"│  · **{h.get('highlight', '')}**："
                            f"{h.get('params', '')} → {h.get('user_benefit', '')}")
            else:
                lines[i] = "│"
            hi += 1
    text = '\n'.join(lines)

    # 实测数据行
    lines = text.split('\n')
    di = 0
    for i, line in enumerate(lines):
        if re.match(r"│  · 数据\d+：来源/条件", line):
            if di < len(test_data):
                d = test_data[di]
                lines[i] = f"│  · **{d.get('data', '')}**：来源/条件：{d.get('source', '')}"
            else:
                lines[i] = "│"
            di += 1
    text = '\n'.join(lines)

    # 车型表格：替换【搭载车型 & 权益】区域的空白行
    # 车型表格：在【搭载车型 & 权益】区域，找到表格分隔线后的第一个空行，插入车辆数据
    # 分隔线格式: │  |------|------|----------|
    vehicle_section_match = re.search(
        r'【搭载车型 & 权益】[^\n]*\n'
        r'│  \| [^\n]+\| [^\n]+\| [^\n]+\| [^\n]*\n'
        r'│  \|[^\n]+\|[^\n]+\|[^\n]+\|[^\n]*\n'
        r'(│[^\n]*)\n',
        text
    )
    if vehicle_section_match and vehicles:
        vehicle_insert = '\n'.join(
            f"│  | {v.get('model', '')} | {v.get('plan', '')} | {v.get('rights', '')} |"
            for v in vehicles
        )
        # 把空白行替换为：车辆行 + 空白行
        text = (text[:vehicle_section_match.start(1)]
                + vehicle_insert + '\n'
                + text[vehicle_section_match.start(1):])

    return text


class A4Skill(Skill):
    @property
    def name(self) -> str:
        return "a4_skill"

    def validate_input(self, input_data: Any) -> bool:
        if not isinstance(input_data, dict):
            return False
        return bool(input_data.get("tech_name"))

    def _replace_template_blocks(self, template: str, ctx: dict) -> str:
        """用 context 数据替换模板中的可填写区域。"""
        # 1. 提取代码块，替换其中内容后存 map
        cb_map: dict[str, str] = {}
        idx = 0

        def extract_and_replace_cb(m):
            nonlocal idx
            key = f"__CB{idx}__"
            cb_map[key] = _do_all_replacements(m.group(0), ctx)
            idx += 1
            return key

        work = re.sub(r"```[\s\S]*?```", extract_and_replace_cb, template)

        # 2. 对外部 Markdown 应用替换
        work = _do_all_replacements(work, ctx)

        # 3. 还原代码块
        for key, cb_content in cb_map.items():
            work = work.replace(key, cb_content)

        return work

    def generate(self, context: dict) -> dict:
        tech_name = context.get("tech_name", "未命名技术")
        template_raw = self.get_template()

        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._default_template_content(context)

        return {
            "skill": self.name,
            "tech_name": tech_name,
            "sections": {
                "tech_name": tech_name,
                "slogan": context.get("slogan", ""),
                "scene_benefits": context.get("scene_benefits", []),
                "tech_highlights": context.get("tech_highlights", []),
                "test_data": context.get("test_data", []),
                "vehicle_models": context.get("vehicle_models", []),
            },
            "content": content,
            "page_format": "A4 (210mm x 297mm)",
            "template_source": "template.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        tech_name = ctx.get("tech_name", "未命名技术")
        slogan = ctx.get("slogan", "")
        scene_benefits = ctx.get("scene_benefits", [])
        highlights = ctx.get("tech_highlights", [])
        test_data = ctx.get("test_data", [])
        vehicles = ctx.get("vehicle_models", [])

        scene_lines = "\n".join(
            f"| {s.get('scene', '')}：{s.get('benefit', '')}"
            for s in scene_benefits
        ) or "(待填写场景与收益)"
        hl_lines = "\n".join(
            f"- **{h.get('highlight', '')}**：{h.get('params', '')} → {h.get('user_benefit', '')}"
            for h in highlights
        ) or "(待填写技术亮点)"
        data_lines = "\n".join(
            f"- **{d.get('data', '')}**（{d.get('source', '')}）"
            for d in test_data
        ) or "(待填写实测数据)"
        vh_lines = "\n".join(
            f"| {v.get('model', '')} | {v.get('plan', '')} | {v.get('rights', '')} |"
            for v in vehicles
        ) or "| | | |"

        return f"""# {tech_name}

> {slogan}

## 场景收益
{scene_lines}

## 技术亮点
{hl_lines}

## 实测数据
{data_lines}

## 搭载车型 & 权益
| 车型 | 方案 | 核心权益 |
|------|------|----------|
{vh_lines}
"""
