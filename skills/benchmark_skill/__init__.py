"""
BenchmarkSkill - 竞品对标分析表生成

基于模板文件生成多维度竞品对比数据表，支持多竞品多维度横向对比。
"""

import re
from typing import Any

from backend.services.skill_loader import Skill


def _do_all_replacements(text: str, ctx: dict) -> str:
    """对文本应用所有字段替换（含 [bracket] 占位符和 ______ 下划线填充项）。"""
    import re as _re

    my_product = ctx.get("my_product", "本品")
    my_tech = ctx.get("my_tech", "")
    analysis_date = ctx.get("analysis_date", "____年__月__日")
    analyst = ctx.get("analyst", "________________")

    # ── 下划线填充项（______ 系列）──────────────────────────────
    # 对比车型行：我方______ vs 竞品A______ vs 竞品B______ vs 竞品C______
    text = _re.sub(r'我方_+', f'我方{my_product}', text)
    text = _re.sub(r'竞品A_+', '竞品A______', text)
    text = _re.sub(r'竞品B_+', '竞品B______', text)
    text = _re.sub(r'竞品C_+', '竞品C______', text)

    # 分析人
    text = _re.sub(r'________________[^_\n]*', analyst, text)
    # 日期
    text = _re.sub(r'____年__月__日', analysis_date, text)
    # 我方机会价格带
    text = _re.sub(r'____________________+', ctx.get('price_opportunity', '_____________________'), text)
    # 核心攻击方向
    attack_directions = ctx.get("attack_directions", [])
    attack_lines = []
    for i, d in enumerate(attack_directions[:3], 1):
        attack_lines.append(f"{'①②③'[i-1]} {d}")
    while len(attack_lines) < 3:
        attack_lines.append(f"{'①②③'[len(attack_lines)]} _____________________________")
    text = _re.sub(r'① _____________________________\n② _____________________________\n③ _____________________________',
                   '\n'.join(attack_lines) + '\n', text)

    # 竞品A/B/C 动态替换
    raw_competitors = ctx.get("competitors", [])
    normalized = []
    for i, c in enumerate(raw_competitors[:3]):
        normalized.append(c if isinstance(c, dict) else {"name": str(c)})
    while len(normalized) < 3:
        normalized.append({"name": f"竞品{len(normalized)+1}"})
    comps = normalized
    comp_names = [c.get("name", f"竞品{i+1}") for i, c in enumerate(comps)]

    text = text.replace("竞品A______", comp_names[0])
    text = text.replace("竞品B______", comp_names[1])
    text = text.replace("竞品C______", comp_names[2])

    # 竞品利润机型
    for i, c in enumerate(comps):
        profit_model = c.get("profit_model", "")
        if profit_model:
            text = _re.sub(rf'竞品[ABC]利润机型：__+版', f'竞品{"ABC"[i]}利润机型：{profit_model}版', text)
        profit_basis = c.get("profit_basis", "")
        if profit_basis:
            text = _re.sub(rf'竞品[ABC]利润机型：.+?：_+', f'竞品{"ABC"[i]}利润机型：{profit_basis}：', text)
        price_gap = c.get("price_gap", "")
        if price_gap:
            text = _re.sub(r'竞品[ABC]万以下：.+?万及以上：.+?无有效布局',
                          price_gap, text)

    # 我方优势/劣势方向
    advantage_directions = ctx.get("advantage_directions", [])
    for i, d in enumerate(advantage_directions[:3], 1):
        text = _re.sub(r'我方最应该主攻的方向.+\n.+\n.+\n', '', text, flags=_re.DOTALL)
    # 留空
    text = _re.sub(r'_____________________________', '（待填写）', text)

    # ── [bracket] 占位符 ─────────────────────────────────────
    text = text.replace("[分析日期]", analysis_date)
    text = text.replace("[分析人]", analyst)
    text = text.replace("[我方车型]", my_product)
    text = text.replace("[竞品A名称]", comp_names[0])
    text = text.replace("[竞品B名称]", comp_names[1])
    text = text.replace("[竞品C名称]", comp_names[2])
    text = text.replace("[本品技术方案]", my_tech)
    text = text.replace("[我方机会价格带]", ctx.get("price_opportunity", "___"))
    text = text.replace("[核心攻击方向列表]", '\n'.join(attack_lines))

    for i, c in enumerate(comps):
        text = text.replace(f"[竞品{i+1}利润机型]", c.get("profit_model", "___版"))
        text = text.replace(f"[竞品{i+1}利润判断依据]", c.get("profit_basis", "___"))
        text = text.replace(f"[竞品{i+1}价格空档分析]", c.get("price_gap", ""))

    # basic_params 替换
    for section_key, section_data in ctx.get("basic_params", {}).items():
        for param_key, param_value in section_data.items():
            text = text.replace(f"[{param_key}_我方]", str(param_value.get("my_product", "")))
            for j in range(3):
                text = text.replace(f"[{param_key}_竞品{j+1}]", str(param_value.get(f"comp{j+1}", "")))

    # config_comparison 替换
    config_items = ctx.get("config_comparison", [])
    lines = text.split('\n')
    ci = 0
    for i, line in enumerate(lines):
        if not (_re.search(r'\|.*\|.*\|.*\|', line) and '我方标配' in line):
            continue
        if ci < len(config_items):
            item = config_items[ci]
            for j, val in enumerate([item.get("config_item", ""),
                                      item.get("my_standard", ""),
                                      item.get("comp1_standard", ""),
                                      item.get("comp2_standard", ""),
                                      item.get("comp3_standard", "")]):
                line = line.replace(f"[配置项{chr(65+j)}]", val)
            lines[i] = line
            ci += 1
    text = '\n'.join(lines)

    # action_items 替换
    action_items = ctx.get("action_items", [])
    lines = text.split('\n')
    ai = 0
    for i, line in enumerate(lines):
        m = _re.match(r"\|[ ]*\|[ ]*\|[ ]*\|", line)
        if m and ai < len(action_items):
            item = action_items[ai]
            lines[i] = f"| {item.get('action', '')} | {item.get('owner', '')} | {item.get('deadline', '')} |"
            ai += 1
    text = '\n'.join(lines)

    return text


class BenchmarkSkill(Skill):
    @property
    def name(self) -> str:
        return "benchmark_skill"

    def validate_input(self, input_data: Any) -> bool:
        return isinstance(input_data, dict) and bool(input_data.get("my_product"))

    def _replace_template_blocks(self, template: str, ctx: dict) -> str:
        """用 context 数据替换模板中的可填写区域（含代码块内替换）。"""
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
        my_product = context.get("my_product", "本品")
        my_tech = context.get("my_tech", "")
        competitors = context.get("competitors", [])
        template_raw = self.get_template()

        if template_raw:
            content = self._replace_template_blocks(template_raw, context)
        else:
            content = self._fallback_content(context)

        summary = self._build_summary(context)

        return {
            "skill": self.name,
            "my_product": my_product,
            "competitors_count": len(competitors),
            "dimensions": context.get("compare_dimensions", []),
            "content": content,
            "summary": summary,
            "template_source": "竞品对标分析表-模板.md",
        }

    def _build_summary(self, ctx: dict) -> str:
        """生成简明总结（用于快速预览）。"""
        my_product = ctx.get("my_product", "本品")
        my_tech = ctx.get("my_tech", "")
        raw_competitors = ctx.get("competitors", [])
        competitors = []
        for c in raw_competitors:
            if isinstance(c, dict):
                competitors.append(c)
            else:
                competitors.append({"name": str(c)})

        summary = f"### {my_product} vs 竞品总结\n\n"
        if my_tech:
            summary += f"**本品技术方案**：{my_tech}\n\n"
        summary += "**优势领域**：\n"
        for c in competitors:
            name = c.get("name", "竞品")
            advantage = c.get("advantage", "")
            if advantage:
                summary += f"- vs {name}：{advantage}\n"
        return summary

    def _fallback_content(self, ctx: dict) -> str:
        """无模板时的降级内容生成。"""
        my_product = ctx.get("my_product", "本品")
        raw_competitors = ctx.get("competitors", [])
        competitors = []
        for c in raw_competitors:
            if isinstance(c, dict):
                competitors.append(c)
            else:
                competitors.append({"name": str(c)})
        dimensions = ctx.get("compare_dimensions", [
            "智能驾驶", "智能座舱", "续航/能耗", "动力性能", "安全配置", "价格区间"
        ])

        header = "| 对比维度 | " + " | ".join([my_product] + [c.get("name", "竞品") for c in competitors]) + " |"
        separator = "|----------|" + "|".join(["----------" for _ in range(len(competitors) + 1)]) + "|"

        rows = []
        for dim in dimensions:
            row = f"| {dim} |"
            for c in competitors:
                val = str(c.get(dim.lower(), c.get(dim, ""))) if c.get(dim.lower(), c.get(dim, "")) else "—"
                row += f" {val} |"
            rows.append(row)

        table = header + "\n" + separator + "\n" + "\n".join(rows)

        summary = self._build_summary(ctx)
        return f"# 竞品对标分析表\n\n{table}\n\n{summary}"
