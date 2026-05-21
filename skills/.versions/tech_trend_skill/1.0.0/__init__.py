"""
tech_trend_skill - TPD Python Skill 包
"""

from backend.services.skill_loader import Skill


class TechTrendSkillSkill(Skill):
    @property
    def name(self) -> str:
        return "tech_trend_skill"

    def generate(self, context):
        return {"skill": self.name, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
