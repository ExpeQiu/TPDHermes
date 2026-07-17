"""模式选型（方法论 §2.5）。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

ModeName = Literal["roundtable", "consult", "swarm", "l1"]


@dataclass
class SelectDecision:
    mode: ModeName
    reason: str


def select_mode(
    goal: str,
    *,
    explicit: Optional[str] = None,
    needs_debate: Optional[bool] = None,
    needs_unified_narrative: Optional[bool] = None,
    decomposable: Optional[bool] = None,
) -> SelectDecision:
    if explicit and explicit != "auto":
        if explicit not in {"roundtable", "consult", "swarm", "l1"}:
            return SelectDecision(mode="consult", reason=f"未知模式 {explicit}，回退 consult")
        return SelectDecision(mode=explicit, reason="用户显式指定")  # type: ignore[arg-type]

    text = (goal or "").lower()
    debate_hints = ["怎么推", "策略", "辩论", "头脑风暴", "圆桌", "多视角", "争议"]
    consult_hints = ["包装", "脚本", "话术", "咨询", "专家", "落地", "白皮书"]
    swarm_hints = ["对比", "调研", "多源", "并行", "供应链", "竞品分析", "汇总", "收集"]

    if needs_debate is True or any(h in text for h in debate_hints):
        return SelectDecision(mode="roundtable", reason="开放议题/多立场冲突 → 圆桌")
    if needs_unified_narrative is True or any(h in text for h in consult_hints):
        return SelectDecision(mode="consult", reason="需主控统一叙事 → Consult")
    if decomposable is True or any(h in text for h in swarm_hints):
        return SelectDecision(mode="swarm", reason="可拆弱依赖任务 → Swarm")
    if len(text) < 20:
        return SelectDecision(mode="l1", reason="短目标，L1 单线程（映射为 consult 简化）")
    return SelectDecision(mode="consult", reason="默认主控交付路径")
