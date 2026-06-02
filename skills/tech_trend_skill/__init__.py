from backend.services.skill_loader import Skill


class TechTrendSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_trend_skill"

    def generate(self, context):
        tech = context.get("tech_name", "技术方向")
        summary = context.get("summary", "")
        content = (
            f"# {tech}趋势研判\n\n"
            f"## 技术现状\n当前{tech}正从功能堆叠走向系统协同，产业链进入提质增效阶段。\n\n"
            "## 关键应用\n"
            "- 应用1：围绕高频场景提升体验一致性。\n"
            "- 应用2：通过平台化能力降低迭代成本。\n"
            "- 应用3：借助数据闭环提升决策效率。\n\n"
            "## 趋势判断\n未来12个月将呈现“能力标准化、场景深耕化、生态协同化”三大趋势。\n\n"
            f"## 备注\n{summary}"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
