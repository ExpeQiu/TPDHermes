from backend.services.skill_loader import Skill


class VideoScriptSkill(Skill):
    @property
    def name(self) -> str:
        return "video_script_skill"

    def generate(self, context):
        product = context.get("product", "产品")
        duration = context.get("duration", "60秒")
        platform = context.get("platform", "短视频平台")
        content = (
            f"# {product}{duration}{platform}视频脚本\n\n"
            "## 分镜\n"
            "1. 3秒开场：问题抛出，建立场景代入。\n"
            "2. 20秒中段：展示核心功能与使用前后对比。\n"
            "3. 20秒强化：补充技术支撑与可信依据。\n"
            "4. 17秒收束：行动引导与品牌记忆点。\n\n"
            "## 旁白\n以用户痛点切入，强调价值闭环：更高效、更安全、更智能。\n\n"
            "## 节奏\n前快后稳，关键画面配合字幕强调结论。\n\n"
            "## 结尾\n以一句品牌主张收口，并引导进一步了解。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
