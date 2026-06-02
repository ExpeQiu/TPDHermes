from backend.services.skill_loader import Skill


class EventPlanSkill(Skill):
    @property
    def name(self) -> str:
        return "event_plan_skill"

    def generate(self, context):
        event = context.get("event", "活动")
        city = context.get("city", "城市")
        budget = context.get("budget", "待定")
        content = (
            f"# {event}执行方案\n\n"
            f"## 活动目标\n在{city}完成品牌声量提升、线索沉淀与渠道协同三重目标。\n\n"
            "## 活动流程\n"
            "1. 预热阶段：内容种草与媒体邀约。\n"
            "2. 爆发阶段：主会场发布与互动体验。\n"
            "3. 复盘阶段：线索跟进与传播回收。\n\n"
            f"## 预算拆分\n总预算约{budget}，建议按“场地执行/内容制作/传播投放”三类配置。\n\n"
            "## 风险与保障\n建立应急预案、流程彩排和现场指挥机制。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
