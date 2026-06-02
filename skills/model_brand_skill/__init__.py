from backend.services.skill_loader import Skill


class ModelBrandSkill(Skill):
    @property
    def name(self) -> str:
        return "model_brand_skill"

    def generate(self, context):
        model = context.get("model", "车型")
        angle = context.get("brand_angle", "技术领先")
        content = (
            f"# {model}品牌赋能策略\n\n"
            f"## 品牌定位\n以“{angle}”作为传播主轴，建立差异化心智。\n\n"
            "## 核心卖点\n"
            "- 卖点1：技术能力可感知，强化用户第一印象。\n"
            "- 卖点2：价值表达可量化，支持销售沟通。\n"
            "- 卖点3：体验路径可复用，提升传播效率。\n\n"
            "## 沟通策略\n围绕车型场景化叙事，统一品牌话术、视觉与内容节奏。"
        )
        return {"skill": self.name, "content": content, "context": context}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
