"""
VideoSkill - 短视频脚本生成

基于短视频脚本模板（30-45秒）：钩子 → 技术展示 → 场景演绎 → 证据点 → CTA。
支持 context 中直接传入数据，或由知识库检索结果填充。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    theme = ctx.get("theme", ctx.get("tech_name", "未命名技术"))
    hook = ctx.get("hook", "")
    tech_display = ctx.get("tech_display", "")
    scene_demo = ctx.get("scene_demo", "")
    evidence = ctx.get("evidence", "")
    cta = ctx.get("cta", "")
    style = ctx.get("style", "cinematic")

    # 基础字段
    text = text.replace("[技术名]", theme)
    text = text.replace("[theme]", theme)

    # 钩子段落的占位符
    text = text.replace("[痛点场景/强烈反差画面]", hook or "高速障碍物画面")
    text = text.replace("__________", hook or f"{theme}核心亮点")

    # 技术展示
    text = text.replace("[技术]", theme)
    text = text.replace("[核心能力]", tech_display or "智能驾驶能力")

    # 场景演绎
    text = text.replace("[具体场景]", scene_demo or "城市道路")
    text = text.replace("[场景描述]", ctx.get("scene_desc", "实测过程"))

    # 证据点
    text = text.replace("[竞品/行业水平]", ctx.get("competitor", "行业水平"))
    text = text.replace("[优势数据]", evidence or "130km/h自动刹停")

    # CTA
    text = text.replace("[行动指引]", cta or "到店30分钟体验")

    return text


class VideoSkill(Skill):
    @property
    def name(self) -> str:
        return "video_skill"

    def validate_input(self, input_data: Any) -> bool:
        if not isinstance(input_data, dict):
            return False
        # theme 或 tech_name 均可
        return bool(input_data.get("theme") or input_data.get("tech_name"))

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
        theme = context.get("theme", context.get("tech_name", "未命名技术"))
        hook = context.get("hook", "")
        tech_display = context.get("tech_display", "")
        scene_demo = context.get("scene_demo", "")
        evidence = context.get("evidence", "")
        cta = context.get("cta", "")
        style = context.get("style", "cinematic")
        duration_sec = context.get("duration_sec", 30)

        template_raw = self.get_template()
        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._default_template_content(context)

        scenes = [
            {"scene_num": 1, "title": "钩子", "time_range": "0-3秒",
             "shot_type": "痛点/反差画面", "script": hook or "（待填写钩子）"},
            {"scene_num": 2, "title": "技术展示", "time_range": "3-13秒",
             "shot_type": "原理动画/类比画面", "script": tech_display or f"基于{theme}，我们实现了……"},
            {"scene_num": 3, "title": "场景演绎", "time_range": "13-20秒",
             "shot_type": "真实路段/用户视角", "script": scene_demo or "在实测场景……"},
            {"scene_num": 4, "title": "证据点", "time_range": "20-25秒",
             "shot_type": "数据图表/认证截图", "script": evidence or "对比行业水平……"},
            {"scene_num": 5, "title": "CTA", "time_range": "25-30秒",
             "shot_type": "门店/产品图/二维码", "script": cta or "到店30分钟体验……"},
        ]

        return {
            "skill": self.name,
            "theme": theme,
            "style": style,
            "total_duration_sec": duration_sec,
            "scenes": scenes,
            "scene_count": len(scenes),
            "content": content,
            "hook_formula": "痛点型/反差型/悬念型/数字型",
            "template_source": "短视频脚本模板.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        theme = ctx.get("theme", ctx.get("tech_name", "未命名技术"))
        return f"""# {theme} 短视频脚本（30-45秒）

## 钩子（0-3秒）
{ctx.get("hook", "（待填写钩子）")}

## 技术展示（3-13秒）
{ctx.get("tech_display", f"基于{theme}，我们实现了……")}

## 场景演绎（13-20秒）
{ctx.get("scene_demo", "在实测场景……")}

## 证据点（20-25秒）
{ctx.get("evidence", "对比行业水平……")}

## CTA（25-30秒）
{ctx.get("cta", "到店30分钟体验……")}
"""
