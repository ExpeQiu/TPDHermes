"""可编程 SDK，镜像 CLI 语义。"""

from __future__ import annotations

from typing import Any, Optional

from multi_agent.config import Settings, load_settings
from multi_agent.coordinator import CoordinatorFacade
from multi_agent.knowledge import list_knowledge_bases
from multi_agent.llm import LLMClient
from multi_agent.modes import ConsultRuntime, RoundtableRuntime, SwarmRuntime
from multi_agent.roles import list_roles_meta, load_role
from multi_agent.skill_packs import list_packs_meta, load_pack
from multi_agent.skills import list_skills_meta, load_skill


class Client:
    def __init__(self, settings: Optional[Settings] = None, **kwargs: Any) -> None:
        if settings is None:
            settings = load_settings(**kwargs)
        self.settings = settings
        self.facade = CoordinatorFacade(settings)
        self.store = self.facade.store

    def run(
        self,
        goal: str,
        *,
        mode: str = "auto",
        pack: Optional[str] = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        result = self.facade.run(goal, mode=mode, pack=pack, **kwargs)
        return result.to_envelope()

    def roundtable(self, topic: str, **kwargs: Any) -> dict[str, Any]:
        llm = LLMClient(self.settings)
        rt = RoundtableRuntime(self.settings, self.store, llm)
        return rt.run(topic, module="mode-roundtable", **kwargs).to_envelope()

    def consult(self, goal: str, **kwargs: Any) -> dict[str, Any]:
        llm = LLMClient(self.settings)
        rt = ConsultRuntime(self.settings, self.store, llm)
        return rt.run(goal, module="mode-consult", **kwargs).to_envelope()

    def swarm(self, goal: str, **kwargs: Any) -> dict[str, Any]:
        llm = LLMClient(self.settings)
        rt = SwarmRuntime(self.settings, self.store, llm)
        return rt.run(goal, module="mode-swarm", **kwargs).to_envelope()

    def status(self, run_id: str) -> Optional[dict[str, Any]]:
        return self.store.load_state(run_id) or self.store.load_result(run_id)

    def trajectory(self, run_id: str) -> str:
        return self.store.load_trajectory(run_id)

    def list_runs(self) -> list[dict[str, Any]]:
        return self.store.list_runs()

    def export_run(self, run_id: str) -> Optional[dict[str, Any]]:
        return self.store.load_bundle(run_id)

    def list_packs(self) -> list[dict[str, Any]]:
        return list_packs_meta()

    def get_pack(self, pack_id: str) -> dict[str, Any]:
        data = load_pack(pack_id)
        return {k: v for k, v in data.items() if not str(k).startswith("_")}

    def list_roles(self) -> list[dict[str, Any]]:
        return list_roles_meta()

    def get_role(self, role_id: str) -> dict[str, Any]:
        return load_role(role_id)

    def list_skills(self) -> list[dict[str, Any]]:
        return list_skills_meta()

    def get_skill(self, skill_id: str) -> dict[str, Any]:
        return load_skill(skill_id)

    def list_knowledge(self) -> list[dict[str, Any]]:
        return list_knowledge_bases()

    def resume(self, run_id: str) -> dict[str, Any]:
        state = self.store.load_state(run_id)
        if not state:
            from multi_agent.utils.errors import MultiAgentError

            raise MultiAgentError(f"找不到 run: {run_id}")
        if state.get("status") == "completed":
            env = self.store.load_result(run_id)
            return env or state
        # demo resume：从 state 的 goal meta 不足时，标记 completed 并返回已有结果
        existing = self.store.load_result(run_id)
        if existing:
            existing["status"] = "completed"
            existing.setdefault("warnings", []).append("resume: 已有结果，标记完成")
            return existing
        goal = state.get("resume_token") or "resume-续跑默认目标"
        return self.run(str(goal), mode=state.get("mode") or "auto")


def create_client(**kwargs: Any) -> Client:
    return Client(**kwargs)
