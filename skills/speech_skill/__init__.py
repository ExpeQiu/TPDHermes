"""
SpeechSkill - 口播文案生成模板
生成适合语音朗读的营销口播文案
"""

from app.services.skill_loader import Skill


class SpeechSkill(Skill):
    @property
    def name(self) -> str:
        return "speech_skill"

    def validate_input(self, input_data):
        if not isinstance(input_data, dict):
            return False
        required = ["product_name", "key_point"]
        return all(k in input_data for k in required)

    def generate(self, context):
        product = context.get("product_name", "")
        key_point = context.get("key_point", "")
        tone = context.get("tone", "enthusiastic")
        duration = context.get("duration_sec", 60)

        # 生成口播文案
        intro_phrases = {
            "enthusiastic": f"大家好！今天给大家强烈推荐——{product}！",
            "casual": f"嘿，朋友们！{product}了解一下？",
            "professional": f"各位好，今天为大家介绍{product}。",
        }
        intro = intro_phrases.get(tone, intro_phrases["enthusiastic"])

        body = context.get("custom_body", "")
        if body:
            body_text = body
        else:
            body_text = (
                f"说到{product}，最大的亮点就是：{key_point}。"
                f"不管你是第一次听说还是已经了解过，这款产品的表现都不会让你失望。"
            )

        cta_phrases = {
            "enthusiastic": "喜欢的话赶紧试试，绝对不会后悔！",
            "casual": "感兴趣就去看看吧，有问题随时问我！",
            "professional": "如需进一步了解，欢迎访问官网或咨询客服。",
        }
        cta = cta_phrases.get(tone, cta_phrases["enthusiastic"])

        full_script = f"{intro}\n\n{body_text}\n\n{cta}"

        # 估算朗读时长
        word_count = len(full_script)
        estimated_sec = word_count // 4  # 约4字/秒

        return {
            "skill": self.name,
            "script": full_script,
            "word_count": word_count,
            "estimated_duration_sec": estimated_sec,
            "product_name": product,
            "key_point": key_point,
            "tone": tone,
            "context_keys": list(context.keys()),
        }
