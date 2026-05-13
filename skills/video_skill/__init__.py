"""
VideoSkill - 视频分镜头脚本生成模板
生成适合拍摄制作的分镜头脚本
"""

from app.services.skill_loader import Skill


class VideoSkill(Skill):
    @property
    def name(self) -> str:
        return "video_skill"

    def validate_input(self, input_data):
        if not isinstance(input_data, dict):
            return False
        return "theme" in input_data

    def generate(self, context):
        theme = context.get("theme", "")
        duration = context.get("duration_sec", 60)
        style = context.get("style", "cinematic")
        scenes_count = context.get("scenes", 4)

        # 生成场景配置
        scene_templates = {
            "cinematic": [
                ("开场", "全景", "大气背景音乐起", 5),
                ("产品特写", "特写", "缓慢推进镜头", 10),
                ("功能展示", "中景", "切换展示各功能", 15),
                ("场景应用", "中景/近景", "模特演示使用场景", 15),
                ("结尾", "全景", "品牌LOGO+口号", 5),
            ],
            "lifestyle": [
                ("开场", "近景", "生活化背景音乐", 5),
                ("引入场景", "中景", "日常使用场景展示", 15),
                ("核心卖点", "特写", "产品亮点特写", 15),
                ("用户体验", "近景", "用户真实反馈画面", 15),
                ("结尾", "中景", "行动号召字幕", 5),
            ],
            "action": [
                ("快切开场", "特写", "动感音乐", 5),
                ("冲击展示", "快速切换", "多角度产品展示", 10),
                ("场景切换", "运动镜头", "快节奏场景切换", 20),
                ("高潮", "特写", "最强卖点冲击", 15),
                ("结尾", "全景", "品牌信息快速闪屏", 5),
            ],
        }

        scenes = scene_templates.get(style, scene_templates["cinematic"])
        # 截取指定数量场景
        scenes = scenes[:scenes_count]

        # 计算总时长
        total_sec = sum(s[3] for s in scenes)
        scale = duration / total_sec if total_sec > 0 else 1

        formatted_scenes = []
        for i, (title, shot, action, orig_dur) in enumerate(scenes):
            scaled_dur = max(2, round(orig_dur * scale))
            formatted_scenes.append({
                "scene_num": i + 1,
                "title": title,
                "shot_type": shot,
                "action": action,
                "duration_sec": scaled_dur,
                "script": f"【第{i+1}镜】{title} | 机位:{shot} | 时长:{scaled_dur}秒 | {action}",
            })

        return {
            "skill": self.name,
            "theme": theme,
            "style": style,
            "total_duration_sec": sum(s["duration_sec"] for s in formatted_scenes),
            "scenes": formatted_scenes,
            "scene_count": len(formatted_scenes),
            "context_keys": list(context.keys()),
        }
