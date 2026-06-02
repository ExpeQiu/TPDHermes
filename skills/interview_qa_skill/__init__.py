from backend.services.skill_loader import Skill


class InterviewQaSkill(Skill):
    @property
    def name(self) -> str:
        return "interview_qa_skill"

    def generate(self, context):
        topic = context.get("topic", "技术话题")
        speaker = context.get("spokesperson", "受访专家")
        content = (
            f"# {topic}采访问答提纲\n\n"
            f"## 采访对象\n{speaker}\n\n"
            "## 核心问题\n"
            "1. 该技术解决了什么关键问题？\n"
            "2. 相比行业方案有何差异化优势？\n"
            "3. 当前落地进展与下一步计划是什么？\n\n"
            "## 参考回答\n建议回答结构：背景-方法-结果-展望，确保信息准确且可传播。\n\n"
            "## 使用建议\n采访前进行问题排序，现场优先追问可量化事实。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
