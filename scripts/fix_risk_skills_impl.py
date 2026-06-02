#!/usr/bin/env python3
"""Repair risk skill implementations with valid Python code."""

from pathlib import Path


def main() -> int:
    base = Path("/app/skills")
    modules = {
        "tech_pr_skill": '''from backend.services.skill_loader import Skill


class TechPrSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_pr_skill"

    def generate(self, context):
        topic = context.get("topic", "技术升级")
        tp = context.get("type", "新闻稿")
        title = f"{topic}正式发布：以技术创新驱动体验升级"
        content = (
            f"# {title}\\n\\n"
            f"## 导语\\n围绕{topic}，我们发布本次{tp}，重点呈现核心技术价值与用户收益。\\n\\n"
            "## 核心亮点\\n"
            "- 亮点1：技术架构升级，提升系统稳定性与响应效率。\\n"
            "- 亮点2：围绕真实场景优化，增强用户体验一致性。\\n"
            "- 亮点3：生态协同能力加强，支撑后续快速迭代。\\n\\n"
            "## 结尾\\n未来将持续推进技术开放与产品落地，形成可复制的创新闭环。"
        )
        return {"skill": self.name, "title": title, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "video_script_skill": '''from backend.services.skill_loader import Skill


class VideoScriptSkill(Skill):
    @property
    def name(self) -> str:
        return "video_script_skill"

    def generate(self, context):
        product = context.get("product", "产品")
        duration = context.get("duration", "60秒")
        platform = context.get("platform", "短视频平台")
        content = (
            f"# {product}{duration}{platform}视频脚本\\n\\n"
            "## 分镜\\n"
            "1. 3秒开场：问题抛出，建立场景代入。\\n"
            "2. 20秒中段：展示核心功能与使用前后对比。\\n"
            "3. 20秒强化：补充技术支撑与可信依据。\\n"
            "4. 17秒收束：行动引导与品牌记忆点。\\n\\n"
            "## 旁白\\n以用户痛点切入，强调价值闭环：更高效、更安全、更智能。\\n\\n"
            "## 节奏\\n前快后稳，关键画面配合字幕强调结论。\\n\\n"
            "## 结尾\\n以一句品牌主张收口，并引导进一步了解。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "model_brand_skill": '''from backend.services.skill_loader import Skill


class ModelBrandSkill(Skill):
    @property
    def name(self) -> str:
        return "model_brand_skill"

    def generate(self, context):
        model = context.get("model", "车型")
        angle = context.get("brand_angle", "技术领先")
        content = (
            f"# {model}品牌赋能策略\\n\\n"
            f"## 品牌定位\\n以“{angle}”作为传播主轴，建立差异化心智。\\n\\n"
            "## 核心卖点\\n"
            "- 卖点1：技术能力可感知，强化用户第一印象。\\n"
            "- 卖点2：价值表达可量化，支持销售沟通。\\n"
            "- 卖点3：体验路径可复用，提升传播效率。\\n\\n"
            "## 沟通策略\\n围绕车型场景化叙事，统一品牌话术、视觉与内容节奏。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "tech_trend_skill": '''from backend.services.skill_loader import Skill


class TechTrendSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_trend_skill"

    def generate(self, context):
        tech = context.get("tech_name", "技术方向")
        summary = context.get("summary", "")
        content = (
            f"# {tech}趋势研判\\n\\n"
            f"## 技术现状\\n当前{tech}正从功能堆叠走向系统协同，产业链进入提质增效阶段。\\n\\n"
            "## 关键应用\\n"
            "- 应用1：围绕高频场景提升体验一致性。\\n"
            "- 应用2：通过平台化能力降低迭代成本。\\n"
            "- 应用3：借助数据闭环提升决策效率。\\n\\n"
            "## 趋势判断\\n未来12个月将呈现“能力标准化、场景深耕化、生态协同化”三大趋势。\\n\\n"
            f"## 备注\\n{summary}"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "event_plan_skill": '''from backend.services.skill_loader import Skill


class EventPlanSkill(Skill):
    @property
    def name(self) -> str:
        return "event_plan_skill"

    def generate(self, context):
        event = context.get("event", "活动")
        city = context.get("city", "城市")
        budget = context.get("budget", "待定")
        content = (
            f"# {event}执行方案\\n\\n"
            f"## 活动目标\\n在{city}完成品牌声量提升、线索沉淀与渠道协同三重目标。\\n\\n"
            "## 活动流程\\n"
            "1. 预热阶段：内容种草与媒体邀约。\\n"
            "2. 爆发阶段：主会场发布与互动体验。\\n"
            "3. 复盘阶段：线索跟进与传播回收。\\n\\n"
            f"## 预算拆分\\n总预算约{budget}，建议按“场地执行/内容制作/传播投放”三类配置。\\n\\n"
            "## 风险与保障\\n建立应急预案、流程彩排和现场指挥机制。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "speech_draft_skill": '''from backend.services.skill_loader import Skill


class SpeechDraftSkill(Skill):
    @property
    def name(self) -> str:
        return "speech_draft_skill"

    def generate(self, context):
        occasion = context.get("occasion", "发布活动")
        speaker = context.get("speaker", "发言人")
        duration = context.get("duration", "8分钟")
        content = (
            f"# {occasion}发言稿（{speaker}）\\n\\n"
            "各位来宾，大家好。今天我们围绕技术升级与用户价值，分享三点内容。\\n\\n"
            "第一，为什么做：面向产业变化与用户期待，我们选择长期主义。\\n"
            "第二，做了什么：在核心能力上持续投入，形成可验证成果。\\n"
            "第三，接下来怎么做：以开放协同推动规模化落地。\\n\\n"
            f"感谢大家支持。以上内容控制在{duration}可完成。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "ip_comm_plan": '''from backend.services.skill_loader import Skill


class IpCommPlanSkill(Skill):
    @property
    def name(self) -> str:
        return "ip_comm_plan"

    def generate(self, context):
        ip = context.get("ip", "技术IP")
        period = context.get("period", "Q3")
        channels = context.get("channels", "全渠道")
        content = (
            f"# {ip}{period}传播计划\\n\\n"
            "## 传播目标\\n提升认知、建立信任、驱动转化。\\n\\n"
            f"## 渠道策略\\n聚焦{channels}，形成“主阵地+协同阵地”组合。\\n\\n"
            "## 内容节奏\\n"
            "- 周期前段：价值认知\\n"
            "- 周期中段：场景验证\\n"
            "- 周期后段：案例沉淀\\n\\n"
            "## 执行建议\\n建立内容日历、统一话术资产、按周复盘优化。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "tech_lockmap_skill": '''from backend.services.skill_loader import Skill


class TechLockmapSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_lockmap_skill"

    def generate(self, context):
        tech = context.get("tech", "技术方向")
        competitors = context.get("competitors", "主要竞品")
        content = (
            f"# {tech}技术卡位图\\n\\n"
            f"## 对标范围\\n竞品集合：{competitors}。\\n\\n"
            "## 卡位维度\\n"
            "- 能力成熟度\\n"
            "- 场景覆盖度\\n"
            "- 商业可行性\\n\\n"
            "## 路线建议\\n短期补齐基础能力，中期形成差异化，长期构建生态壁垒。\\n\\n"
            "## 输出结论\\n明确“主攻赛道、协同赛道、观察赛道”三层技术路线。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
        "interview_qa_skill": '''from backend.services.skill_loader import Skill


class InterviewQaSkill(Skill):
    @property
    def name(self) -> str:
        return "interview_qa_skill"

    def generate(self, context):
        topic = context.get("topic", "技术话题")
        speaker = context.get("spokesperson", "受访专家")
        content = (
            f"# {topic}采访问答提纲\\n\\n"
            f"## 采访对象\\n{speaker}\\n\\n"
            "## 核心问题\\n"
            "1. 该技术解决了什么关键问题？\\n"
            "2. 相比行业方案有何差异化优势？\\n"
            "3. 当前落地进展与下一步计划是什么？\\n\\n"
            "## 参考回答\\n建议回答结构：背景-方法-结果-展望，确保信息准确且可传播。\\n\\n"
            "## 使用建议\\n采访前进行问题排序，现场优先追问可量化事实。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
''',
    }

    for name, code in modules.items():
        p = base / name / "__init__.py"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(code, encoding="utf-8")
        print(f"updated {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
