"""
SalesSkill - 销售话术手册生成

基于销售话术模板生成完整话术手册。
使用 self.get_template() 读取 template.md 并渲染。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    vehicle = ctx.get("vehicle_model", "")
    tech_brand = ctx.get("tech_brand", "")
    selling_points = ctx.get("top_selling_points", [])
    # 兼容 dict list 和 string list
    normalized = []
    for sp in selling_points:
        if isinstance(sp, dict):
            normalized.append(sp.get('name', '') or sp.get('desc', ''))
        elif isinstance(sp, str):
            normalized.append(sp)
    selling_points = normalized
    target_users = ctx.get("target_users", [])
    target_competitors = ctx.get("target_competitors", [])

    # 基础字段
    text = text.replace("[车型名称]", vehicle)
    text = text.replace("[车型]", vehicle)
    text = text.replace("[技术品牌]", tech_brand)
    text = text.replace("[技术名称]", tech_brand)
    text = text.replace("[核心卖点一句话]", "/".join(selling_points[:2]) if selling_points else "（待填写）")

    # 基本信息表格
    sp_text = "、".join([f"①{sp}" for sp in selling_points[:3]]) if selling_points else "①______ ②______ ③______"
    text = text.replace("| 车型 | |", f"| 车型 | {vehicle} |")
    text = text.replace("| 技术品牌 | |", f"| 技术品牌 | {tech_brand} |")
    text = text.replace("| 主打卖点 | ①______ ②______ ③______ |", f"| 主打卖点 | {sp_text} |")
    competitor_text = "、".join(target_competitors) if target_competitors else "（待填写）"
    text = text.replace("| 对标竞品 | |", f"| 对标竞品 | {competitor_text} |")

    # 卖点填充（卖点①/②/③标题）
    for i, sp in enumerate(selling_points[:3], 1):
        text = text.replace(f"### 2.{i} 卖点①：_____________________________",
                            f"### 2.{i} 卖点①：{sp}")
        text = text.replace(f"### 2.{i} 卖点②：_____________________________",
                            f"### 2.{i} 卖点②：{sp}")
        text = text.replace(f"### 2.{i} 卖点③：_____________________________",
                            f"### 2.{i} 卖点③：{sp}")

    # 场景化话术（3类用户）
    user_types = ["家庭用户（二有孩/三代同堂）", "商务接待用户", "科技爱好者"]
    for ut in user_types:
        text = text.replace(f"### 3.1 {user_types[0]}\n\n**切入**：",
                            f"### 3.1 {ut}\n**切入**：")
    # 通用用户类型
    for i, user in enumerate(target_users[:3], 1):
        user_type = user.get("type", user_types[i-1] if i <= len(user_types) else "通用用户")
        pain = user.get("pain_point", "")
        pitch = user.get("pitch", "")
        text = text.replace(f"### 3.{i} {user_types[i-1]}\n\n**切入**：\n> \"看您这情况，平时{user_types[i-1]}居多吧？最怕的就是{pain}，对吧？",
                           f"### 3.{i} {user_type}\n\n**切入**：\n> \"看您这情况，平时{user_type}居多吧？最怕的就是{pain}，对吧？")

    return text


class SalesSkill(Skill):
    @property
    def name(self) -> str:
        return "sales_skill"

    def validate_input(self, input_data: Any) -> bool:
        return isinstance(input_data, dict) and bool(
            input_data.get("vehicle_model") or input_data.get("tech_name"))

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
        vehicle = context.get("vehicle_model", "")
        tech_brand = context.get("tech_brand", context.get("tech_name", ""))
        selling_points = context.get("top_selling_points", [])
        sections = {
            "opening": "",
            "selling_points": "",
            "scene_scripts": "",
            "objections": "",
            "closing": "",
        }

        template_raw = self.get_template()
        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._default_template_content(context)

        return {
            "skill": self.name,
            "vehicle_model": vehicle,
            "tech_brand": tech_brand,
            "sections": sections,
            "content": content,
            "template_source": "销售话术手册-模板.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        vehicle = ctx.get("vehicle_model", "（待填写）")
        tech_brand = ctx.get("tech_brand", "（待填写）")
        sp = ctx.get("top_selling_points", [])
        return f"""# {vehicle} 销售话术手册

## 基本信息
| 项目 | 内容 |
|------|------|
| 车型 | {vehicle} |
| 技术品牌 | {tech_brand} |
| 主打卖点 | {", ".join(sp[:3]) if sp else "（待填写）"} |
"""
