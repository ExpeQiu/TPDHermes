from backend.services.skill_loader import Skill


class IpCommPlanSkill(Skill):
    @property
    def name(self) -> str:
        return "ip_comm_plan"

    def generate(self, context):
        ip = context.get("ip", "技术IP")
        period = context.get("period", "Q3")
        channels = context.get("channels", "全渠道")
        content = (
            f"# {ip}{period}传播计划\n\n"
            "## 传播目标\n提升认知、建立信任、驱动转化。\n\n"
            f"## 渠道策略\n聚焦{channels}，形成“主阵地+协同阵地”组合。\n\n"
            "## 内容节奏\n"
            "- 周期前段：价值认知\n"
            "- 周期中段：场景验证\n"
            "- 周期后段：案例沉淀\n\n"
            "## 执行建议\n建立内容日历、统一话术资产、按周复盘优化。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
