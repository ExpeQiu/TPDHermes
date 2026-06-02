from backend.services.skill_loader import Skill


class TechLockmapSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_lockmap_skill"

    def generate(self, context):
        tech = context.get("tech", "技术方向")
        competitors = context.get("competitors", "主要竞品")
        content = (
            f"# {tech}技术卡位图\n\n"
            f"## 对标范围\n竞品集合：{competitors}。\n\n"
            "## 卡位维度\n"
            "- 能力成熟度\n"
            "- 场景覆盖度\n"
            "- 商业可行性\n\n"
            "## 路线建议\n短期补齐基础能力，中期形成差异化，长期构建生态壁垒。\n\n"
            "## 输出结论\n明确“主攻赛道、协同赛道、观察赛道”三层技术路线。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
