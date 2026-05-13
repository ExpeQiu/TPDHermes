"""
A4Skill - A4技术规格文档生成模板
生成标准A4格式的产品技术文档
"""

from app.services.skill_loader import Skill


class A4Skill(Skill):
    @property
    def name(self) -> str:
        return "a4_skill"

    def validate_input(self, input_data):
        if not isinstance(input_data, dict):
            return False
        required = ["product_name", "specs"]
        return all(k in input_data for k in required)

    def generate(self, context):
        product = context.get("product_name", "未命名产品")
        specs = context.get("specs", {})
        lang = context.get("language", "zh")
        include_image = context.get("include_image_placeholder", True)

        # 规格项格式化
        spec_rows = []
        for key, value in specs.items():
            spec_rows.append({
                "param": key,
                "value": str(value),
                "formatted": f"**{key}**: {value}",
            })

        # 技术亮点段落
        highlights = context.get("highlights", [])
        if not highlights:
            highlights = [
                "采用最新一代技术架构",
                "性能卓越，稳定可靠",
                "用户体验优先设计",
            ]

        # 生成文档结构
        sections = []

        # 1. 概述
        sections.append({
            "title": "产品概述" if lang == "zh" else "Product Overview",
            "content": f"{product}是一款专为满足市场需求而设计的高性能产品。"
        })

        # 2. 技术规格
        sections.append({
            "title": "技术规格" if lang == "zh" else "Technical Specifications",
            "content_table": spec_rows,
        })

        # 3. 核心优势
        sections.append({
            "title": "核心优势" if lang == "zh" else "Core Advantages",
            "bullet_points": highlights,
        })

        # 4. 应用场景
        use_cases = context.get("use_cases", ["通用场景"])
        sections.append({
            "title": "应用场景" if lang == "zh" else "Application Scenarios",
            "bullet_points": use_cases,
        })

        # 5. 合规说明
        certs = context.get("certifications", ["符合国家标准"])
        sections.append({
            "title": "合规与认证" if lang == "zh" else "Compliance & Certification",
            "bullet_points": certs,
        })

        # 页眉页脚
        header = f"{product} 技术规格文档" if lang == "zh" else f"{product} Technical Specification"
        footer = "CONFIDENTIAL - Internal Use Only" if lang == "en" else "机密文件 - 内部使用"

        return {
            "skill": self.name,
            "product_name": product,
            "language": lang,
            "sections": sections,
            "spec_rows": spec_rows,
            "highlights": highlights,
            "page_format": "A4 (210mm x 297mm)",
            "include_image_placeholder": include_image,
            "header": header,
            "footer": footer,
            "context_keys": list(context.keys()),
        }
