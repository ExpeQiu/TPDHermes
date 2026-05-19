"""
IPMatrixSkill - 技术IP矩阵图生成

基于IP矩阵图模板（七步法）：Slogan → 定位 → 愿景 → 体验 → 亮点 → 底座 → 车型。
使用 self.get_template() 读取 template.md 并渲染。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换。"""
    tech_name = ctx.get("tech_name", "未命名技术")
    slogan = ctx.get("slogan", "")
    positioning = ctx.get("positioning", "")
    vision = ctx.get("vision", "")
    experience = ctx.get("experience", {})
    highlights = ctx.get("highlights", [])
    tech_stack = ctx.get("tech_stack", {})
    vehicle_timeline = ctx.get("vehicle_timeline", [])

    # 基础字段
    text = text.replace("[技术名]", tech_name)
    text = text.replace("Slogan（一句话承诺）", slogan)

    # 单独的中文占位符（在slogan整体替换之后做兜底）
    text = text.replace("[技术]", ctx.get("tech", tech_name))
    text = text.replace("[场景]", ctx.get("scene", ctx.get("target_user", "")))
    text = text.replace("[可感知收益]", ctx.get("perceivable_benefit", ctx.get("core_value", "")))
    text = text.replace("[目标用户]", ctx.get("target_user", "目标用户"))
    text = text.replace("[价值形容词]", ctx.get("value_adj", ctx.get("core_value", "更安全")))
    text = text.replace("**[技术名]**", f"**{tech_name}**")

    # 第一步：Slogan
    if slogan:
        text = text.replace(
            "[技术名]，基于[技术]，在[场景]实现[可感知收益]，让[目标用户]更[价值形容词]。",
            slogan
        )

    # 第二步：定位
    if positioning:
        text = text.replace("[技术名]是____领域最____的方案", positioning)
        text = text.replace("____领域最____的方案", positioning)

    # 第三步：愿景
    if vision:
        text = text.replace("3-5年后用户对这项技术的认知：____________", vision)
        text = text.replace("____________", vision)

    # 第四步：用户体验表格（4个维度）
    exp_map = {
        "旗舰安全": experience.get("safety", ""),
        "旗舰智能": experience.get("intelligent", ""),
        "旗舰素质": experience.get("quality", ""),
        "旗舰空间": experience.get("space", ""),
    }
    for dim, val in exp_map.items():
        if val:
            text = text.replace(f"| {dim} | __________ |", f"| {dim} | {val} |")

    # 第五步：技术亮点
    # 格式：- 技术点1：___（含参数+场景+收益）
    lines = text.split('\n')
    hi = 0
    for i, line in enumerate(lines):
        if re.match(r"- 技术点\d+：___（含参数\+场景\+收益）", line):
            if hi < len(highlights):
                h = highlights[hi]
                lines[i] = (f"- {h.get('point', '')}：{h.get('params_scene_benefit', '')}")
            else:
                lines[i] = f"- {'技术亮点'}"
            hi += 1
    text = '\n'.join(lines)

    # 第六步：技术底座表格（算力/算法/数据/生态）
    stack_map = {
        "算力": tech_stack.get("computing", ""),
        "算法": tech_stack.get("algorithm", ""),
        "数据": tech_stack.get("data", ""),
        "生态": tech_stack.get("ecosystem", ""),
    }
    for label, val in stack_map.items():
        if val:
            text = text.replace(f"| {label} | __________ |", f"| {label} | {val} |")

    # 第七步：车型×时间表格
    vh_lines = text.split('\n')
    vi = 0
    for i, line in enumerate(vh_lines):
        if re.match(r"\| __________ \| H_ \| ____年__月 \|", line):
            if vi < len(vehicle_timeline):
                v = vehicle_timeline[vi]
                plan = v.get("plan_level", "H_")
                time = v.get("launch_time", "____年__月")
                model = v.get("model", "__________")
                vh_lines[i] = f"| {model} | {plan} | {time} |"
            vi += 1
    text = '\n'.join(vh_lines)

    # IP矩阵汇总表 - 填入Slogan和定位
    text = text.replace("| Slogan | |", f"| Slogan | {slogan or tech_name} |")
    text = text.replace("| 定位 | |", f"| 定位 | {positioning or '（待填写）'} |")
    text = text.replace("| 愿景 | |", f"| 愿景 | {vision or '（待填写）'} |")

    return text


class IPMatrixSkill(Skill):
    @property
    def name(self) -> str:
        return "ip_matrix_skill"

    def validate_input(self, input_data: Any) -> bool:
        return isinstance(input_data, dict) and bool(input_data.get("tech_name"))

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
                "slogan": context.get("slogan", ""),
                "positioning": context.get("positioning", ""),
                "vision": context.get("vision", ""),
                "experience": context.get("experience", {}),
                "highlights": context.get("highlights", []),
                "tech_stack": context.get("tech_stack", {}),
                "vehicle_timeline": context.get("vehicle_timeline", []),
            },
            "content": content,
            "template_source": "IP矩阵图模板.md",
        }

    def _default_template_content(self, ctx: dict) -> str:
        tech_name = ctx.get("tech_name", "未命名技术")
        slogan = ctx.get("slogan", "")
        return f"""# {tech_name} IP矩阵图

## 第一步：Slogan
> {slogan or '（待填写）'}

## 第二步：技术品牌定位
{ctx.get("positioning", "（待填写）")}

## 第三步：技术品牌愿景
{ctx.get("vision", "（待填写）")}
"""
