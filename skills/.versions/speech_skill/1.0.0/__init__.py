"""
SpeechSkill - 发言稿生成

基于发言稿模板结构：开场痛点 → 技术方案 → 用户价值 → 收尾CTA。
支持 context 中直接传入数据，或由知识库检索结果填充。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    tech_name = ctx.get("tech_name", "未命名技术")
    slogan = ctx.get("slogan", "")
    scene_pain = ctx.get("scene_pain", "")
    tech_solution = ctx.get("tech_solution", "")
    highlights = ctx.get("highlights", [])
    user_value = ctx.get("user_value", "")
    cta = ctx.get("cta", "")

    # 基础字段
    text = text.replace("[技术名]", tech_name)
    text = text.replace("Slogan（一句话承诺）", slogan)
    text = text.replace("**[技术名]**", f"**{tech_name}**")

    # 开场痛点：开场痛点段落
    # 模板：[具体场景] 和 [具体问题]
    text = text.replace("[具体场景]", scene_pain or "长途高速出行")
    text = text.replace("[具体问题]", ctx.get("specific_problem", "障碍物反应不及时"))
    text = text.replace("[简明机理]", tech_solution or f"{tech_name}解决方案")
    text = text.replace("[关键矛盾]", ctx.get("key_conflict", "安全与便捷的矛盾"))

    # 技术亮点块：在结构框架代码块中找 [技术亮点1/2/3] 并替换
    lines = text.split('\n')
    hi = 0
    for i, line in enumerate(lines):
        if re.match(r"\[技术亮点\d+\]：场景\+数据", line):
            if hi < len(highlights):
                h = highlights[hi]
                lines[i] = f"**{h.get('name', '')}**：{h.get('scene_data', '')}"
            else:
                lines[i] = f"**{tech_name}亮点**：核心能力展示"
            hi += 1
    text = '\n'.join(lines)

    # 用户价值
    text = text.replace("[可复现场景]", ctx.get("reproducible_scene", "日常驾驶场景"))
    text = text.replace("[量化指标]", ctx.get("quantitative_metric", "130km/h自动刹停"))
    text = text.replace("[正向收益]", user_value or "更安全、更轻松的驾驶体验")

    # 收尾CTA
    text = text.replace("[具体行动/权益]", cta or "到店预约体验")

    return text


class SpeechSkill(Skill):
    @property
    def name(self) -> str:
        return "speech_skill"

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
        slogan = context.get("slogan", "")
        highlights = context.get("highlights", [])
        tone = context.get("tone", "professional")

        template_raw = self.get_template()
        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._default_template_content(context)

        # 估算字数和时长（基于替换后的文本）
        total_chars = len(content)
        estimated_min = total_chars / 400  # 发言约400字/分钟

        return {
            "skill": self.name,
            "tech_name": tech_name,
            "tone": tone,
            "sections": [
                {"type": "开场痛点", "content": context.get("scene_pain", "")},
                {"type": "技术方案", "content": context.get("tech_solution", "")},
                {"type": "用户价值", "content": context.get("user_value", "")},
                {"type": "收尾", "content": context.get("cta", "")},
            ],
            "content": content,
            "word_count": total_chars,
            "estimated_minutes": round(estimated_min, 1),
            "template_source": "发言稿模板.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        tech_name = ctx.get("tech_name", "未命名技术")
        scene_pain = ctx.get("scene_pain", "长途高速障碍物")
        tech_solution = ctx.get("tech_solution", "")
        highlights = ctx.get("highlights", [])
        user_value = ctx.get("user_value", "")
        cta = ctx.get("cta", "")

        hl_lines = "\n".join(
            f"**{h.get('name', '')}**：{h.get('scene_data', '')}"
            for h in highlights
        ) or f"**{tech_name}亮点**：核心能力展示"

        return f"""# {tech_name} 发言稿

> {ctx.get("slogan", "")}

## 开场痛点

各位好。

不知道大家有没有这样的经历——{scene_pain}……

这些场景，我相信在座每个人都遇到过。

## 技术方案

我们用{tech_solution}解决关键矛盾。

{hl_lines}

## 用户价值

因此，用户能感知到：{user_value}

## 收尾

{cta}

谢谢大家。
"""
