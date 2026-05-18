"""
MaterialSkill - 传播素材清单生成

基于传播素材清单模板生成完整物料清单。
使用 self.get_template() 读取 template.md 并渲染。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    project = ctx.get("project_name", "")
    vehicle = ctx.get("vehicle_model", "")
    theme = ctx.get("tech_theme", ctx.get("slogan", ""))
    budget = ctx.get("budget", "")
    launch_date = ctx.get("launch_date", "")
    selling_points = ctx.get("top_selling_points", [])

    sp_text = "、".join(selling_points[:3]) if selling_points else "卖点①、卖点②、卖点③"

    # 基础字段
    text = text.replace("[车型]", vehicle)
    text = text.replace("[推广主题]", theme)
    text = text.replace("[卖点①]", selling_points[0] if len(selling_points) > 0 else "卖点①")
    text = text.replace("[卖点②]", selling_points[1] if len(selling_points) > 1 else "卖点②")
    text = text.replace("[卖点③]", selling_points[2] if len(selling_points) > 2 else "卖点③")
    text = text.replace("[场景描述]", ctx.get("scene_desc", "实测场景"))
    text = text.replace("___年__月__日", launch_date or "___年__月__日")

    # 基本信息表格
    text = text.replace("| 推广车型 | |", f"| 推广车型 | {vehicle} |")
    text = text.replace("| 推广主题 | |", f"| 推广主题 | {theme} |")
    text = text.replace("| 预算总额 | |", f"| 预算总额 | {budget} |")
    text = text.replace("| 负责人 | |", f"| 负责人 | {ctx.get('owner', '（待填写）')} |")
    text = text.replace("| 创建日期 | |", f"| 创建日期 | {ctx.get('create_date', '（待填写）')} |")

    # 视频大纲中的卖点
    text = text.replace("[卖点拓展]", selling_points[1] if len(selling_points) > 1 else "卖点②")
    text = text.replace("[技术亮点]", selling_points[0] if selling_points else "核心卖点")

    # 技术解读视频中的技术原理
    text = text.replace("技术原理：用通俗语言+动画解释技术原理",
                        f"技术原理：用通俗语言+动画解释{theme or '本技术'}")

    return text


class MaterialSkill(Skill):
    @property
    def name(self) -> str:
        return "material_skill"

    def validate_input(self, input_data: Any) -> bool:
        return isinstance(input_data, dict) and bool(
            input_data.get("project_name") or input_data.get("vehicle_model"))

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
        project = context.get("project_name", "")
        vehicle = context.get("vehicle_model", "")
        theme = context.get("tech_theme", "")
        sections = {
            "basic_info": "",
            "video_materials": "",
            "print_materials": "",
            "kol_cooperation": "",
            "media_plan": "",
            "timeline": "",
        }

        template_raw = self.get_template()
        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._default_template_content(context)

        return {
            "skill": self.name,
            "project_name": project,
            "vehicle_model": vehicle,
            "tech_theme": theme,
            "sections": sections,
            "content": content,
            "template_source": "传播素材清单-模板.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        project = ctx.get("project_name", "（待填写）")
        vehicle = ctx.get("vehicle_model", "（待填写）")
        theme = ctx.get("tech_theme", "（待填写）")
        return f"""# {project} 传播素材清单

## 基本信息
| 项目 | 内容 |
|------|------|
| 推广车型 | {vehicle} |
| 推广主题 | {theme} |
"""
