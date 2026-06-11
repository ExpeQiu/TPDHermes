from backend.services.skill_loader import Skill

class UploadedSkill(Skill):
    @property
    def name(self):
        return "ws_upload_cc0265f6"

    def generate(self, context):
        return {"from": "ws_upload_cc0265f6", "ok": True}
