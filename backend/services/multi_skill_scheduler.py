"""
MultiSkillScheduler - 多 Skill 智能调度器

功能：
  1. 根据场景自动选择最优 Skill 或 Skill 组合
  2. 支持按顺序调用多个 Skill 并合并结果
  3. 场景到 Skill 的映射规则可配置
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .skill_loader import SkillLoader, get_loader


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
    "IP矩阵": {
        "primary": "ip_matrix_skill",
        "fallback": [],
        "description": "技术IP矩阵图七步法",
    },
    "传播素材": {
        "primary": "material_skill",
        "fallback": [],
        "description": "传播素材与媒介投放清单",
    },
    "销售话术": {
        "primary": "sales_skill",
        "fallback": [],
        "description": "4S店实战销售话术手册",
    },
    "趋势洞察": {
        "primary": "tech_trend_skill",
        "fallback": [],
        "description": "技术发展趋势洞察报告",
    },
    "车型赋能": {
        "primary": "model_brand_skill",
        "fallback": [],
        "description": "技术品牌赋能车型策略",
    },
    "一页纸": {
        "primary": "a4_skill",
        "fallback": [],
        "description": "A4技术规格一页纸",
    },
    "竞品对标": {
        "primary": "benchmark_skill",
        "fallback": [],
        "description": "竞品对标分析表",
    },
    "品牌命名": {
        "primary": "brand_name_skill",
        "fallback": [],
        "description": "技术品牌命名策略",
    },
    "调研计划": {
        "primary": "brand_research_plan",
        "fallback": [],
        "description": "技术品牌调研计划",
    },
    "调研报告": {
        "primary": "brand_research_report",
        "fallback": [],
        "description": "技术品牌调研报告",
    },
    "展具概念": {
        "primary": "display_concept_skill",
        "fallback": [],
        "description": "IP技术展具概念策划",
    },
    "展具说明": {
        "primary": "display_guide_skill",
        "fallback": [],
        "description": "IP技术展具使用说明书",
    },
    "展具立项": {
        "primary": "display_project_skill",
        "fallback": [],
        "description": "IP技术展具制作立项",
    },
    "活动策划": {
        "primary": "event_plan_skill",
        "fallback": [],
        "description": "技术推广活动策划",
    },
    "采访QA": {
        "primary": "interview_qa_skill",
        "fallback": [],
        "description": "领导采访QA",
    },
    "认证策划": {
        "primary": "ip_cert_plan",
        "fallback": [],
        "description": "IP技术认证策划",
    },
    "IP传播": {
        "primary": "ip_comm_plan",
        "fallback": [],
        "description": "技术IP传播策划",
    },
    "IP全案": {
        "primary": "ip_pack_skill",
        "fallback": [],
        "description": "技术IP包装全案",
    },
    "IP货架": {
        "primary": "ip_shelf_skill",
        "fallback": [],
        "description": "技术IP包装货架",
    },
    "知识收割": {
        "primary": "knowledge_harvest_draft",
        "fallback": [],
        "description": "知识收割草稿",
    },
    "领导讲稿": {
        "primary": "speech_draft_skill",
        "fallback": ["speech_skill"],
        "description": "领导正式讲稿",
    },
    "互锁地图": {
        "primary": "tech_lockmap_skill",
        "fallback": [],
        "description": "技术品牌互锁地图",
    },
    "新闻稿": {
        "primary": "tech_pr_skill",
        "fallback": [],
        "description": "IP技术传播稿",
    },
    "导演脚本": {
        "primary": "video_script_skill",
        "fallback": [],
        "description": "技术推广导演脚本",
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
        "口播": ["口播", "配音", "语音", "朗读", "播报", "speech", "发言稿", "演讲稿", "发布会讲稿"],
        "视频": ["短视频", "30秒", "45秒", "视频号", "抖音脚本"],
        "导演脚本": ["导演脚本", "宣传片脚本", "分镜脚本", "视频创意", "技术推广视频"],
        "规格": ["规格", "参数", "技术文档", "spec"],
        "一页纸": ["A4", "一页纸", "规格单页", "技术单页", "精华页"],
        "综合": ["完整", "全套", "营销物料", "综合"],
        "IP矩阵": ["IP矩阵", "技术品牌矩阵", "七步法", "技术IP矩阵"],
        "传播素材": ["传播素材", "素材清单", "宣发物料", "投放计划", "媒介投放", "KOL", "物料齐套"],
        "销售话术": ["销售话术", "门店话术", "顾问话术", "异议处理", "试驾转化", "逼单", "4S店"],
        "趋势洞察": ["技术趋势", "发展趋势", "趋势洞察", "行业趋势", "技术品牌营销"],
        "车型赋能": ["技术品牌赋能", "车型策略", "配置倒挂", "单独命名", "车型亮点", "IP赋能车型"],
        "竞品对标": ["竞品对标", "竞品对比", "对标分析", "参数对比", "优劣势"],
        "品牌命名": ["品牌命名", "技术品牌命名", "命名报告", "Slogan命名"],
        "调研计划": ["调研计划", "调研立项", "样本规划", "供应商招标"],
        "调研报告": ["调研报告", "调研结案", "品牌调研报告", "管理者摘要"],
        "展具概念": ["展具概念", "展台概念", "技术展具", "展具策划"],
        "展具说明": ["展具说明书", "使用说明书", "操作手册", "安装拆卸", "展具维护"],
        "展具立项": ["展具立项", "制作立项书", "展具预算", "展台制作"],
        "活动策划": ["活动策划", "车展", "技术日", "线下活动", "参展方案"],
        "采访QA": ["采访QA", "媒体问答", "发布会问答", "敏感问题", "领导采访"],
        "认证策划": ["技术认证", "第三方认证", "认证策划", "认证立项", "权威认证"],
        "IP传播": ["IP传播", "传播策划", "发布传播", "传播ROADMAP", "传播预算"],
        "IP全案": ["IP包装", "包装全案", "技术IP全案", "IP打造", "从0到1"],
        "IP货架": ["IP货架", "包装货架", "信息包", "技术包装沉淀"],
        "知识收割": ["知识收割", "对话沉淀", "知识草稿", "经验沉淀"],
        "领导讲稿": ["领导讲稿", "开场演讲", "技术日讲稿", "领导致辞", "正式讲稿"],
        "互锁地图": ["互锁地图", "技术规划", "车型节奏", "品牌联动", "触点规划", "车型互锁"],
        "新闻稿": ["新闻稿", "传播稿", "官方通稿", "PR稿", "技术发布稿"],
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
