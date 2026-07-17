"""上下文分片（方法论 §六）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ShardContext:
    """主控持有目标/约束/验收；子 Agent 仅获必要共享。"""

    goal: str
    constraints: list[str] = field(default_factory=list)
    acceptance: list[str] = field(default_factory=list)
    shared_brief: str = ""

    def for_subagent(self, task: str, *, max_shared_chars: int = 800) -> dict[str, Any]:
        shared = self.shared_brief or (
            f"目标：{self.goal}\n约束：{'; '.join(self.constraints) or '无'}"
        )
        if len(shared) > max_shared_chars:
            shared = shared[: max_shared_chars - 1] + "…"
        return {
            "task": task,
            "shared": shared,
            "acceptance": list(self.acceptance),
        }

    def orchestrator_view(self) -> dict[str, Any]:
        return {
            "goal": self.goal,
            "constraints": self.constraints,
            "acceptance": self.acceptance,
        }
