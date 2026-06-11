from backend.services.skill_loader import Skill

class UploadedSkill(Skill):
    @property
    def name(self):
        return "ws_upload_a701a68e"

    def generate(self, context):
        return {"from": "ws_upload_a701a68e", "ok": True}
