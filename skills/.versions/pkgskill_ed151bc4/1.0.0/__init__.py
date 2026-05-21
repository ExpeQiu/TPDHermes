from backend.services.skill_loader import Skill

class PkgSkill(Skill):
    @property
    def name(self):
        return "pkgskill_ed151bc4"

    def generate(self, context):
        return {"ok": True}

    def validate_input(self, input_data):
        return True
