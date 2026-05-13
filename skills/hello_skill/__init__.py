"""
HelloSkill - 测试用示例 Skill
"""

from app.services.skill_loader import Skill


class HelloSkill(Skill):
    @property
    def name(self) -> str:
        return "hello_skill"

    def generate(self, context):
        name = context.get("name", "World")
        return {
            "greeting": f"Hello, {name}!",
            "skill": self.name,
            "context_keys": list(context.keys()),
        }

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
