"""CoordinatorFacade：选型 + 三模式 + handoff。"""

from __future__ import annotations

from typing import Any, Callable, Optional

from multi_agent.config import Settings, load_settings
from multi_agent.llm import LLMClient
from multi_agent.modes import ConsultRuntime, RoundtableRuntime, SwarmRuntime
from multi_agent.selector import select_mode
from multi_agent.trajectory import RunResult, TrajectoryStore
from multi_agent.utils.logger import get_logger

logger = get_logger()


class CoordinatorFacade:
    def __init__(self, settings: Optional[Settings] = None) -> None:
        self.settings = settings or load_settings()
        self.store = TrajectoryStore(self.settings.runs_dir)
        self.llm = LLMClient(self.settings)
        self.roundtable = RoundtableRuntime(self.settings, self.store, self.llm)
        self.consult = ConsultRuntime(self.settings, self.store, self.llm)
        self.swarm = SwarmRuntime(self.settings, self.store, self.llm)

    def run(
        self,
        goal: str,
        *,
        mode: str = "auto",
        pack: Optional[str] = None,
        rounds: int = 2,
        expert: Optional[str] = None,
        max_parallel: Optional[int] = None,
        topic: Optional[str] = None,
        handoff_to_consult: bool = False,
        discussion_mode: str = "round_robin",
        consensus_enabled: bool = False,
        consensus_threshold: float = 0.7,
        debate_config: Optional[dict[str, Any]] = None,
        moderator_enabled: bool = True,
        context: Optional[str] = None,
        on_started: Optional[Callable[[str], None]] = None,
    ) -> RunResult:
        pack = pack or self.settings.default_pack
        decision = select_mode(goal or topic or "", explicit=mode)
        logger.info("模式选型: %s (%s)", decision.mode, decision.reason)

        resolved = decision.mode
        if resolved == "l1":
            resolved = "consult"

        if resolved == "roundtable":
            result = self.roundtable.run(
                topic or goal,
                pack=pack,
                rounds=rounds,
                module="run-start",
                discussion_mode=discussion_mode,
                consensus_enabled=consensus_enabled,
                consensus_threshold=consensus_threshold,
                debate_config=debate_config,
                moderator_enabled=moderator_enabled,
                context=context,
                on_started=on_started,
            )
            result.meta["select_reason"] = decision.reason
            self.store.save_result(result)
            if handoff_to_consult:
                logger.info("handoff roundtable → consult run_id=%s", result.run_id)
                follow = self.consult.run(
                    goal or topic or "",
                    pack=pack,
                    expert=expert,
                    module="run-start",
                    handoff_from=result.run_id,
                )
                follow.meta["select_reason"] = decision.reason
                follow.warnings.append(f"已从圆桌 {result.run_id} handoff")
                self.store.save_result(follow)
                return follow
            return result

        if resolved == "swarm":
            result = self.swarm.run(
                goal,
                max_parallel=max_parallel,
                pack=pack,
                module="run-start",
            )
            result.meta["select_reason"] = decision.reason
            self.store.save_result(result)
            return result

        result = self.consult.run(
            goal,
            pack=pack,
            expert=expert,
            module="run-start",
        )
        result.meta["select_reason"] = decision.reason
        self.store.save_result(result)
        return result
