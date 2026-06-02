from backend.services.skill_loader import Skill


class TechPrSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_pr_skill"

    def generate(self, context):
        topic = context.get("topic", "技术升级")
        tp = context.get("type", "新闻稿")
        title = f"{topic}正式发布：以技术创新驱动体验升级"
        content = (
            f"# {title}\n\n"
            f"## 导语\n围绕{topic}，我们发布本次{tp}，重点呈现核心技术价值与用户收益。\n\n"
            "## 核心亮点\n"
            "- 亮点1：技术架构升级，提升系统稳定性与响应效率。\n"
            "- 亮点2：围绕真实场景优化，增强用户体验一致性。\n"
            "- 亮点3：生态协同能力加强，支撑后续快速迭代。\n\n"
            "## 结尾\n未来将持续推进技术开放与产品落地，形成可复制的创新闭环。"
        )
        return {"skill": self.name, "title": title, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
