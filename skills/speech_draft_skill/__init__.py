from backend.services.skill_loader import Skill


class SpeechDraftSkill(Skill):
    @property
    def name(self) -> str:
        return "speech_draft_skill"

    def generate(self, context):
        occasion = context.get("occasion", "发布活动")
        speaker = context.get("speaker", "发言人")
        duration = context.get("duration", "8分钟")
        content = (
            f"# {occasion}发言稿（{speaker}）\n\n"
            "各位来宾，大家好。今天我们围绕技术升级与用户价值，分享三点内容。\n\n"
            "第一，为什么做：面向产业变化与用户期待，我们选择长期主义。\n"
            "第二，做了什么：在核心能力上持续投入，形成可验证成果。\n"
            "第三，接下来怎么做：以开放协同推动规模化落地。\n\n"
            f"感谢大家支持。以上内容控制在{duration}可完成。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
