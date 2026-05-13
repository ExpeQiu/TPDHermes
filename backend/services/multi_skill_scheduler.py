"""
MultiSkillScheduler - 多 Skill 智能调度器

功能：
  1. 根据场景自动选择最优 Skill 或 Skill 组合
  2. 支持按顺序调用多个 Skill 并合并结果
  3. 场景到 Skill 的映射规则可配置
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .skill_loader import Skill, SkillLoader, get_loader


# ─── 内置场景规则 ────────────────────────────────────────────────────────────

DEFAULT_SCENE_RULES: Dict[str, Dict[str, Any]] = {
    "口播": {
        "primary": "speech_skill",
        "fallback": [],
        "description": "语音口播类内容",
    },
    "口播+规格": {
        "primary": "speech_skill",
        "secondary": ["a4_skill"],
        "description": "口播文案 + A4规格文档",
    },
    "视频": {
        "primary": "video_skill",
        "fallback": [],
        "description": "视频分镜脚本",
    },
    "视频+口播": {
        "primary": "video_skill",
        "secondary": ["speech_skill"],
        "description": "视频脚本 + 配套口播",
    },
    "规格": {
        "primary": "a4_skill",
        "fallback": [],
        "description": "A4技术文档",
    },
    "综合": {
        "primary": "a4_skill",
        "secondary": ["speech_skill", "video_skill"],
        "description": "完整营销物料：规格文档+口播+视频",
    },
    "默认": {
        "primary": None,
        "fallback": [],
        "description": "未识别场景，尝试加载所有Skill",
    },
}


# ─── 场景识别器 ──────────────────────────────────────────────────────────────

class SceneClassifier:
    """根据用户输入关键词识别对应场景"""

    KEYWORD_MAP = {
        "口播": ["口播", "配音", "语音", "朗读", "播报", "speech"],
        "视频": ["视频", "分镜", "脚本", "拍摄", "video"],
        "规格": ["规格", "参数", "技术文档", "A4", "spec"],
        "综合": ["完整", "全套", "营销物料", "综合"],
    }

    def classify(self, query: str) -> str:
        """
        根据 query 关键词识别场景名
        Returns: scene_key 如 "口播", "视频", "规格", "综合", "默认"
        """
        q = query.lower()
        scores: Dict[str, int] = {}

        for scene, keywords in self.KEYWORD_MAP.items():
            scores[scene] = sum(1 for kw in keywords if kw.lower() in q)

        # 取最高分场景
        best = max(scores.items(), key=lambda x: x[1])
        return best[0] if best[1] > 0 else "默认"


# ─── MultiSkillScheduler ──────────────────────────────────────────────────────

class MultiSkillScheduler:
    """
    多 Skill 调度器

    使用方式:
        scheduler = MultiSkillScheduler()
        result = scheduler.schedule("口播+规格", {"product_name": "XX", ...})
        # 或自动识别场景:
        result = scheduler.auto_schedule("帮我做一个口播和规格文档", {...})
    """

    def __init__(
        self,
        loader: Optional[SkillLoader] = None,
        scene_rules: Optional[Dict[str, Dict[str, Any]]] = None,
    ):
        self.loader = loader or get_loader()
        self.scene_rules = scene_rules or DEFAULT_SCENE_RULES
        self.classifier = SceneClassifier()

    # ── 公开 API ──────────────────────────────────────────────────────────────

    def schedule(
        self,
        scene: str,
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        按指定场景调度 Skill

        Args:
            scene: 场景名，如 "口播", "视频+口播", "综合"
            context: 传递给每个 Skill 的上下文数据
        Returns:
            合并后的结果字典
        """
        rule = self.scene_rules.get(scene, self.scene_rules["默认"])
        primary_name = rule.get("primary")
        secondary_names: List[str] = rule.get("secondary", [])
        all_skills = [primary_name] + secondary_names if primary_name else secondary_names

        if not primary_name and not secondary_names:
            # "默认" 或未识别 → 尝试所有 Skill
            all_skills = self.loader.discover()

        results = []
        errors = []

        for skill_name in all_skills:
            if skill_name is None:
                continue
            try:
                res = self._call_skill(skill_name, context)
                results.append({
                    "skill": skill_name,
                    "success": res.get("success", False),
                    "content": res.get("content"),
                    "error": res.get("error"),
                })
            except Exception as e:
                errors.append({"skill": skill_name, "error": str(e)})

        # 合并内容
        merged = self._merge_results(results)

        return {
            "scene": scene,
            "description": rule.get("description", ""),
            "skills_called": [r["skill"] for r in results],
            "results": results,
            "errors": errors,
            "merged": merged,
            "total_skills": len(results),
            "successful_skills": sum(1 for r in results if r["success"]),
        }

    def auto_schedule(
        self,
        query: str,
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        根据 query 自动识别场景并调度

        Args:
            query: 用户描述（如 "帮我做一个口播和视频脚本"）
            context: 传递给每个 Skill 的上下文数据
        Returns:
            同 schedule() 的结果，外加识别到的 scene
        """
        scene = self.classifier.classify(query)
        result = self.schedule(scene, context)
        result["auto_detected_scene"] = scene
        result["query"] = query
        return result

    def schedule_multiple(
        self,
        skill_names: List[str],
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        直接指定多个 Skill 名称，顺序调用并合并

        Args:
            skill_names: Skill 名称列表
            context: 上下文数据
        Returns:
            同 schedule() 的结果
        """
        results = []
        errors = []

        for skill_name in skill_names:
            try:
                res = self._call_skill(skill_name, context)
                results.append({
                    "skill": skill_name,
                    "success": res.get("success", False),
                    "content": res.get("content"),
                    "error": res.get("error"),
                })
            except Exception as e:
                errors.append({"skill": skill_name, "error": str(e)})

        merged = self._merge_results(results)

        return {
            "scene": "custom",
            "description": f"自定义组合: {', '.join(skill_names)}",
            "skills_called": [r["skill"] for r in results],
            "results": results,
            "errors": errors,
            "merged": merged,
            "total_skills": len(results),
            "successful_skills": sum(1 for r in results if r["success"]),
        }

    def list_scenes(self) -> List[Dict[str, Any]]:
        """返回所有可用场景规则"""
        return [
            {"scene": k, **v}
            for k, v in self.scene_rules.items()
        ]

    def add_scene_rule(
        self,
        scene: str,
        primary: Optional[str] = None,
        secondary: Optional[List[str]] = None,
        description: str = "",
    ) -> None:
        """动态添加/覆盖场景规则"""
        self.scene_rules[scene] = {
            "primary": primary,
            "secondary": secondary or [],
            "description": description,
        }

    # ── 内部 ─────────────────────────────────────────────────────────────────

    def _call_skill(self, name: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """调用单个 Skill 并返回原始结果"""
        return self.loader.call(name, context)

    def _merge_results(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        将多个 Skill 的 content 合并为一个字典
        策略：
          - 收集所有 content 的顶层 key
          - 同名 key 则加 skill 前缀区分
        """
        merged: Dict[str, Any] = {}
        skill_key_map: Dict[str, str] = {}  # original_key -> renamed_key

        for result in results:
            if not result["success"] or result["content"] is None:
                continue
            skill_name = result["skill"]
            content = result["content"]

            for k, v in content.items():
                if k not in merged:
                    merged[k] = v
                    skill_key_map[k] = skill_name
                else:
                    # 冲突：加前缀
                    renamed_key = f"{skill_name}_{k}"
                    merged[renamed_key] = v

        merged["_skill_key_map"] = skill_key_map
        return merged


# ─── 全局单例（便捷） ─────────────────────────────────────────────────────────

_default_scheduler: Optional[MultiSkillScheduler] = None

def get_scheduler() -> MultiSkillScheduler:
    global _default_scheduler
    if _default_scheduler is None:
        _default_scheduler = MultiSkillScheduler()
    return _default_scheduler
