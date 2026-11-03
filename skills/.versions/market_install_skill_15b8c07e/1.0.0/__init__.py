"""
market_install_skill_15b8c07e - TPD Python Skill 包
"""

from pathlib import Path

from backend.services.skill_loader import Skill
from backend.services.skill_script_runner import generate_content_from_scripts


class MarketInstallSkill15b8c07eSkill(Skill):
    @property
    def name(self) -> str:
        return "market_install_skill_15b8c07e"

    def generate(self, context):
        skill_dir = getattr(self, "skill_path", None) or Path(__file__).resolve().parent
        content = generate_content_from_scripts(skill_dir, context or {})
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
