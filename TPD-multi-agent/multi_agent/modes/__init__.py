"""三种模式 Runtime。"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Optional

from multi_agent.config import Settings
from multi_agent.context import ShardContext
from multi_agent.knowledge import retrieve_context
from multi_agent.llm import LLMClient
from multi_agent.skill_packs import load_pack
from multi_agent.trajectory import Delivery, RunResult, TrajectoryStore
from multi_agent.utils.errors import ExecFailError, NoDeliveryError
from multi_agent.utils.logger import get_logger

logger = get_logger()

DISCUSSION_MODES = frozenset({"round_robin", "parallel", "debate"})


def _kb_context(settings: Settings, query: str) -> str:
    try:
        block = retrieve_context(settings.knowledge_base, query)
    except Exception as exc:  # noqa: BLE001
        logger.warning("知识库检索失败 kb=%s err=%s", settings.knowledge_base, exc)
        return ""
    if block:
        logger.info(
            "已注入知识库上下文 kb=%s chars=%s",
            settings.knowledge_base,
            len(block),
        )
    return block


def _with_kb(prompt: str, kb_block: str) -> str:
    if not kb_block:
        return prompt
    return f"{kb_block}\n\n---\n请优先依据上方知识库内容作答；若不足再补充推理。\n\n{prompt}"


def _run_base(
    store: TrajectoryStore,
    settings: Settings,
    *,
    module: str,
    mode: str,
    coordinator: str,
    goal: str,
) -> tuple[str, TrajectoryStore]:
    run_id = store.new_run_id()
    store.append_event(
        run_id,
        "分派",
        task=goal,
        actor=coordinator,
        inputs=[
            f"mode={mode}",
            f"module={module}",
            f"kb={settings.data_source}",
            f"llm={settings.llm_mode}",
        ],
        notes="run 开始",
    )
    logger.info(
        "run_id=%s mode=%s kb=%s llm=%s 开始",
        run_id,
        mode,
        settings.data_source,
        settings.llm_mode,
    )
    return run_id, store


def _normalize_discussion_mode(value: str | None) -> str:
    raw = (value or "round_robin").strip().lower().replace("-", "_")
    aliases = {"roundrobin": "round_robin", "serial": "round_robin"}
    mode = aliases.get(raw, raw)
    if mode not in DISCUSSION_MODES:
        logger.warning("未知 discussion_mode=%s，回退 round_robin", value)
        return "round_robin"
    return mode


def _split_debate_sides(
    roles: list[dict[str, Any]],
    debate_config: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any] | None]:
    """按配置或均分角色为正/反方，裁判可选。"""
    cfg = debate_config or {}
    by_id = {str(r.get("id")): r for r in roles if r.get("id")}
    pro_ids = [str(x) for x in (cfg.get("pro_role_ids") or cfg.get("proRoleIds") or [])]
    con_ids = [str(x) for x in (cfg.get("con_role_ids") or cfg.get("conRoleIds") or [])]
    judge_id = str(cfg.get("judge_role_id") or cfg.get("judgeRoleId") or "").strip() or None

    if pro_ids or con_ids:
        pro = [by_id[i] for i in pro_ids if i in by_id]
        con = [by_id[i] for i in con_ids if i in by_id]
    else:
        mid = max(1, len(roles) // 2)
        pro, con = roles[:mid], roles[mid:] or roles[:1]

    judge = by_id.get(judge_id) if judge_id else None
    if not pro:
        pro = roles[:1] or [{"id": "pro", "name": "正方", "perspective": "支持议题主张"}]
    if not con:
        con = roles[-1:] or [{"id": "con", "name": "反方", "perspective": "质疑议题主张"}]
    return pro, con, judge


def _parse_consensus_payload(raw: str) -> tuple[bool, float]:
    text = (raw or "").strip()
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            score = float(data.get("score", data.get("threshold", 0)))
            reached = bool(data.get("consensus", data.get("reached", score >= 0.7)))
            return reached, max(0.0, min(1.0, score))
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    match = re.search(r"\{[^{}]*\}", text)
    if match:
        try:
            data = json.loads(match.group(0))
            score = float(data.get("score", 0))
            reached = bool(data.get("consensus", score >= 0.7))
            return reached, max(0.0, min(1.0, score))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    lowered = text.lower()
    if "true" in lowered or "达成" in text or "共识" in text:
        return True, 0.8
    return False, 0.4


class RoundtableRuntime:
    def __init__(self, settings: Settings, store: TrajectoryStore, llm: LLMClient) -> None:
        self.settings = settings
        self.store = store
        self.llm = llm

    def _speak(
        self,
        *,
        role: dict[str, Any],
        topic: str,
        round_no: int,
        kb_block: str,
        stance: str | None = None,
    ) -> str:
        name = role.get("name") or role.get("id") or "专家"
        stance_hint = ""
        if stance == "pro":
            stance_hint = "你属于正方，请论证支持立场，并回应对方质疑。"
        elif stance == "con":
            stance_hint = "你属于反方，请提出质疑与风险，并挑战正方主张。"
        system = role.get("system") or (
            f"你是{name}，保持立场清晰，简洁有力。"
            + (f" {stance_hint}" if stance_hint else "")
        )
        return self.llm.complete(
            _with_kb(
                f"议题：{topic}\n轮次：{round_no}\n你的视角：{role.get('perspective')}\n"
                f"{stance_hint}\n给出核心观点与一条 Action。",
                kb_block,
            ),
            role=role.get("id", "expert"),
            system=system,
        )

    def _append_speech(
        self,
        *,
        run_id: str,
        store: TrajectoryStore,
        transcripts: list[str],
        role: dict[str, Any],
        round_no: int,
        opinion: str,
        label: str | None = None,
    ) -> None:
        name = role.get("name") or role.get("id") or "专家"
        prefix = f"**{name}**"
        if label:
            prefix = f"**{name}（{label}）**"
        line = f"{prefix}（R{round_no}）：{opinion}"
        transcripts.append(line)
        store.append_event(
            run_id,
            "完成",
            task=f"圆桌发言 R{round_no}",
            actor=str(name),
            outputs=[opinion[:200]],
        )

    def _run_round_robin(
        self,
        *,
        run_id: str,
        store: TrajectoryStore,
        transcripts: list[str],
        roles: list[dict[str, Any]],
        topic: str,
        round_no: int,
        kb_block: str,
    ) -> None:
        for role in roles:
            opinion = self._speak(
                role=role, topic=topic, round_no=round_no, kb_block=kb_block
            )
            self._append_speech(
                run_id=run_id,
                store=store,
                transcripts=transcripts,
                role=role,
                round_no=round_no,
                opinion=opinion,
            )

    def _run_parallel(
        self,
        *,
        run_id: str,
        store: TrajectoryStore,
        transcripts: list[str],
        roles: list[dict[str, Any]],
        topic: str,
        round_no: int,
        kb_block: str,
    ) -> None:
        if not roles:
            return
        results: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=min(8, len(roles))) as pool:
            futures = {
                pool.submit(
                    self._speak,
                    role=role,
                    topic=topic,
                    round_no=round_no,
                    kb_block=kb_block,
                ): role
                for role in roles
            }
            for fut in as_completed(futures):
                role = futures[fut]
                rid = str(role.get("id") or role.get("name") or id(role))
                try:
                    results[rid] = fut.result()
                except Exception as exc:  # noqa: BLE001
                    raise ExecFailError(f"并行发言失败: {exc}") from exc
        for role in roles:
            rid = str(role.get("id") or role.get("name") or id(role))
            opinion = results.get(rid, "")
            self._append_speech(
                run_id=run_id,
                store=store,
                transcripts=transcripts,
                role=role,
                round_no=round_no,
                opinion=opinion,
            )

    def _run_debate(
        self,
        *,
        run_id: str,
        store: TrajectoryStore,
        transcripts: list[str],
        pro_roles: list[dict[str, Any]],
        con_roles: list[dict[str, Any]],
        judge: dict[str, Any] | None,
        topic: str,
        round_no: int,
        kb_block: str,
    ) -> None:
        for role in pro_roles:
            opinion = self._speak(
                role=role,
                topic=topic,
                round_no=round_no,
                kb_block=kb_block,
                stance="pro",
            )
            self._append_speech(
                run_id=run_id,
                store=store,
                transcripts=transcripts,
                role=role,
                round_no=round_no,
                opinion=opinion,
                label="正方",
            )
        for role in con_roles:
            opinion = self._speak(
                role=role,
                topic=topic,
                round_no=round_no,
                kb_block=kb_block,
                stance="con",
            )
            self._append_speech(
                run_id=run_id,
                store=store,
                transcripts=transcripts,
                role=role,
                round_no=round_no,
                opinion=opinion,
                label="反方",
            )
        if judge:
            verdict = self.llm.complete(
                _with_kb(
                    f"议题：{topic}\n轮次：{round_no}\n请作为裁判点评本轮正反方要点，"
                    f"给出分数（0-10）与一条改进建议。\n近期发言：\n"
                    + "\n".join(transcripts[-6:]),
                    kb_block,
                ),
                role=judge.get("id", "judge"),
                system=judge.get("system")
                or f"你是裁判{judge.get('name') or ''}，中立评判。",
            )
            self._append_speech(
                run_id=run_id,
                store=store,
                transcripts=transcripts,
                role=judge,
                round_no=round_no,
                opinion=verdict,
                label="裁判",
            )

    def _detect_consensus(
        self,
        *,
        topic: str,
        transcripts: list[str],
        round_no: int,
        threshold: float,
        kb_block: str,
    ) -> tuple[bool, float]:
        if self.settings.mock_mode:
            # demo：第 2 轮起视为可达成共识，便于验证提前终止
            score = 0.85 if round_no >= 2 else 0.45
            reached = score >= threshold
            logger.info(
                "共识检测(mock) round=%s score=%.2f threshold=%.2f reached=%s",
                round_no,
                score,
                threshold,
                reached,
            )
            return reached, score

        raw = self.llm.complete(
            _with_kb(
                "判断下列圆桌发言是否已形成可执行共识。"
                f"只输出 JSON：{{\"consensus\":true|false,\"score\":0.0-1.0}}\n"
                f"议题：{topic}\n阈值：{threshold}\n发言：\n"
                + "\n".join(transcripts[-10:]),
                kb_block,
            ),
            role="consensus",
            system="你是共识检测器，只输出 JSON。",
        )
        reached, score = _parse_consensus_payload(raw)
        reached = reached and score >= threshold
        logger.info(
            "共识检测 round=%s score=%.2f threshold=%.2f reached=%s",
            round_no,
            score,
            threshold,
            reached,
        )
        return reached, score

    def run(
        self,
        topic: str,
        *,
        pack: str = "nev-tech",
        rounds: int = 2,
        module: str = "mode-roundtable",
        discussion_mode: str = "round_robin",
        consensus_enabled: bool = False,
        consensus_threshold: float = 0.7,
        debate_config: dict[str, Any] | None = None,
        moderator_enabled: bool = True,
        context: str | None = None,
    ) -> RunResult:
        discussion_mode = _normalize_discussion_mode(discussion_mode)
        rounds = max(1, int(rounds or 1))
        threshold = max(0.5, min(1.0, float(consensus_threshold or 0.7)))

        pack_data = load_pack(pack)
        roles = [r for r in pack_data.get("roundtable_roles", []) if r.get("id") != "moderator"]
        moderator = next(
            (r for r in pack_data.get("roundtable_roles", []) if r.get("id") == "moderator"),
            {"id": "moderator", "name": "主持人"},
        )
        pro_roles, con_roles, judge = ([], [], None)
        if discussion_mode == "debate":
            pro_roles, con_roles, judge = _split_debate_sides(roles, debate_config)
            if judge is None and moderator_enabled:
                judge = moderator

        run_id, store = _run_base(
            self.store,
            self.settings,
            module=module,
            mode="roundtable",
            coordinator=moderator.get("name", "主持人"),
            goal=topic,
        )

        transcripts: list[str] = []
        opening = (
            f"### 开场（{moderator.get('name')}）\n议题：{topic}\n"
            f"讨论模式：{discussion_mode}\n请各位给出最核心破局建议。"
        )
        transcripts.append(opening)
        store.append_event(
            run_id,
            "决策点",
            task="圆桌开场",
            actor=moderator.get("name", "主持人"),
            outputs=[topic, discussion_mode],
        )
        kb_retrieved = _kb_context(self.settings, topic)
        kb_block = kb_retrieved
        extra_context = (context or "").strip()
        if extra_context:
            kb_block = (
                f"{extra_context}\n\n{kb_retrieved}".strip()
                if kb_retrieved
                else extra_context
            )
            store.append_event(
                run_id,
                "决策点",
                task="注入外部材料上下文",
                actor="context",
                outputs=[extra_context[:240]],
                metrics={"chars": len(extra_context)},
            )
        if kb_retrieved:
            store.append_event(
                run_id,
                "决策点",
                task="知识库检索",
                actor="knowledge",
                inputs=[self.settings.data_source],
                outputs=[kb_retrieved[:240]],
            )

        consensus_reached = False
        consensus_score = 0.0
        stopped_at_round = rounds
        for r in range(1, rounds + 1):
            logger.info(
                "run_id=%s 圆桌第 %s/%s 轮 mode=%s",
                run_id,
                r,
                rounds,
                discussion_mode,
            )
            if discussion_mode == "parallel":
                self._run_parallel(
                    run_id=run_id,
                    store=store,
                    transcripts=transcripts,
                    roles=roles,
                    topic=topic,
                    round_no=r,
                    kb_block=kb_block,
                )
            elif discussion_mode == "debate":
                self._run_debate(
                    run_id=run_id,
                    store=store,
                    transcripts=transcripts,
                    pro_roles=pro_roles,
                    con_roles=con_roles,
                    judge=judge,
                    topic=topic,
                    round_no=r,
                    kb_block=kb_block,
                )
            else:
                self._run_round_robin(
                    run_id=run_id,
                    store=store,
                    transcripts=transcripts,
                    roles=roles,
                    topic=topic,
                    round_no=r,
                    kb_block=kb_block,
                )

            if moderator_enabled and discussion_mode != "debate" and r >= 2:
                conflict = self.llm.complete(
                    _with_kb(
                        f"议题：{topic}\n请升维冲突：如何在吸引眼球的同时保持高端信仰？",
                        kb_block,
                    ),
                    role="moderator",
                    system=moderator.get("system") or "你是主持人，引导融合。",
                )
                transcripts.append(f"**升维冲突**：{conflict}")
                store.append_event(
                    run_id,
                    "决策点",
                    task="升维冲突",
                    actor=moderator.get("name", "主持人"),
                    outputs=[conflict[:200]],
                )

            if consensus_enabled and r < rounds:
                consensus_reached, consensus_score = self._detect_consensus(
                    topic=topic,
                    transcripts=transcripts,
                    round_no=r,
                    threshold=threshold,
                    kb_block=kb_block,
                )
                store.append_event(
                    run_id,
                    "决策点",
                    task="共识检测",
                    actor="consensus",
                    outputs=[f"score={consensus_score:.2f}", f"reached={consensus_reached}"],
                )
                if consensus_reached:
                    stopped_at_round = r
                    transcripts.append(
                        f"**共识检测**：第 {r} 轮达成共识（score={consensus_score:.2f}），提前结束。"
                    )
                    logger.info("run_id=%s 共识提前终止于第 %s 轮", run_id, r)
                    break
        else:
            stopped_at_round = rounds

        synthesis = self.llm.complete(
            _with_kb(
                f"综合以下圆桌发言，输出 Master Plan（概念 slogan + 三步行动）：\n"
                + "\n".join(transcripts[-8:]),
                kb_block,
            ),
            role="moderator",
            system=moderator.get("system") or "你是主持人，收束为可执行方案。",
        )
        body = (
            "# 圆桌 Master Plan\n\n"
            + f"**议题**：{topic}\n\n"
            + f"**讨论模式**：{discussion_mode}\n\n"
            + "\n\n".join(transcripts)
            + f"\n\n## 综合方案\n\n{synthesis}\n"
        )
        delivery = Delivery(title=f"圆桌方案：{topic[:40]}", body_markdown=body)
        if not synthesis.strip():
            raise NoDeliveryError("圆桌未产出有效综合方案")

        result = RunResult(
            run_id=run_id,
            module=module,
            mode="roundtable",
            coordinator=moderator.get("name", "主持人"),
            delivery=delivery,
            data_source=self.settings.data_source,
            meta={
                "pack": pack,
                "rounds": rounds,
                "discussion_mode": discussion_mode,
                "consensus_enabled": consensus_enabled,
                "consensus_threshold": threshold,
                "consensus_reached": consensus_reached,
                "consensus_score": consensus_score,
                "stopped_at_round": stopped_at_round,
                "debate": (
                    {
                        "pro_role_ids": [r.get("id") for r in pro_roles],
                        "con_role_ids": [r.get("id") for r in con_roles],
                        "judge_role_id": (judge or {}).get("id"),
                    }
                    if discussion_mode == "debate"
                    else None
                ),
                "context_chars": len(extra_context),
                "knowledge_base": self.settings.data_source,
                "llm_mode": self.settings.llm_mode,
            },
        )
        store.append_event(
            run_id,
            "完成",
            task="主持人收束",
            actor=moderator.get("name", "主持人"),
            outputs=[delivery.title],
        )
        store.save_result(result)
        return result


class ConsultRuntime:
    def __init__(self, settings: Settings, store: TrajectoryStore, llm: LLMClient) -> None:
        self.settings = settings
        self.store = store
        self.llm = llm

    def _consult(self, expert: dict[str, Any], goal: str, kb_block: str = "") -> str:
        system = expert.get("system") or (
            f"你是{expert.get('name')}，只输出本领域观点，不要抢主控话术。"
        )
        return self.llm.complete(
            _with_kb(
                f"目标：{goal}\n专家职责触发条件：{expert.get('when')}\n请给出该维度的精炼结论。",
                kb_block,
            ),
            role=expert.get("id", "expert"),
            system=system,
        )

    def run(
        self,
        goal: str,
        *,
        pack: str = "nev-tech",
        expert: Optional[str] = None,
        module: str = "mode-consult",
        handoff_from: Optional[str] = None,
    ) -> RunResult:
        pack_data = load_pack(pack)
        experts = pack_data.get("consult_experts", [])
        if expert:
            experts = [e for e in experts if e.get("id") == expert]
            if not experts:
                raise ExecFailError(f"未知专家: {expert}")

        run_id, store = _run_base(
            self.store,
            self.settings,
            module=module,
            mode="consult",
            coordinator="主控·技术营销战略家",
            goal=goal,
        )
        if handoff_from:
            store.append_event(
                run_id,
                "分派",
                task="模式 handoff",
                actor="CoordinatorFacade",
                inputs=[f"from={handoff_from}"],
                notes="圆桌收敛后转入 Consult 落地",
            )

        kb_block = _kb_context(self.settings, goal)
        if kb_block:
            store.append_event(
                run_id,
                "决策点",
                task="知识库检索",
                actor="knowledge",
                inputs=[self.settings.data_source],
                outputs=[kb_block[:240]],
            )

        consult_logs: list[str] = []
        # 默认调用链：tech → scene → market → content（可裁剪）
        order = experts or pack_data.get("consult_experts", [])
        for exp in order:
            logger.info("run_id=%s Consult %s", run_id, exp.get("id"))
            out = self._consult(exp, goal, kb_block)
            consult_logs.append(f"### {exp.get('name')} (`{exp.get('tool')}`)\n\n{out}")
            store.append_event(
                run_id,
                "完成",
                task=f"Consult {exp.get('id')}",
                actor=exp.get("name", ""),
                inputs=[goal],
                outputs=[out[:200]],
            )

        final = self.llm.complete(
            _with_kb(
                f"你是主控战略家。用户目标：{goal}\n以下是专家咨询结果，请综合为统一口吻的最终交付"
                f"（策略 + 核心话术，不要罗列专家原文）：\n\n" + "\n\n".join(consult_logs),
                kb_block,
            ),
            role="main",
            system="主控唯一对用户发言，专家观点已内化。",
        )
        body = (
            f"# 主控交付\n\n**目标**：{goal}\n\n## 综合方案\n\n{final}\n\n"
            f"## 专家审计轨迹\n\n" + "\n\n".join(consult_logs) + "\n"
        )
        delivery = Delivery(title=f"Consult：{goal[:40]}", body_markdown=body)
        if not final.strip():
            raise NoDeliveryError("Consult 无有效交付")

        result = RunResult(
            run_id=run_id,
            module=module,
            mode="consult",
            coordinator="主控·技术营销战略家",
            delivery=delivery,
            data_source=self.settings.data_source,
            meta={
                "pack": pack,
                "experts": [e.get("id") for e in order],
                "handoff_from": handoff_from,
                "knowledge_base": self.settings.data_source,
                "llm_mode": self.settings.llm_mode,
            },
        )
        store.save_result(result)
        return result


class SwarmRuntime:
    """STORM: Split → Triage → Orchestrate → Rollup → Monitor。"""

    def __init__(self, settings: Settings, store: TrajectoryStore, llm: LLMClient) -> None:
        self.settings = settings
        self.store = store
        self.llm = llm

    def _split(self, goal: str, max_parallel: int) -> list[str]:
        if self.settings.mock_mode:
            base = [
                f"子任务A：收集与「{goal}」相关的事实要点",
                f"子任务B：分析差异/风险维度",
                f"子任务C：整理可执行结论与表格骨架",
            ]
            return base[: max(1, min(max_parallel, len(base)))]
        raw = self.llm.complete(
            f"将目标拆成不超过 {max_parallel} 个相互独立的子任务，每行一个，不要编号以外的废话。\n目标：{goal}",
            role="orchestrator",
            system="你是 Swarm Orchestrator，只输出子任务列表。",
        )
        tasks = [line.strip(" -•\t") for line in raw.splitlines() if line.strip()]
        return tasks[:max_parallel] or [f"完成：{goal}"]

    def run(
        self,
        goal: str,
        *,
        max_parallel: Optional[int] = None,
        module: str = "mode-swarm",
        pack: str = "nev-tech",
    ) -> RunResult:
        mp = max_parallel or self.settings.max_parallel
        run_id, store = _run_base(
            self.store,
            self.settings,
            module=module,
            mode="swarm",
            coordinator="Orchestrator",
            goal=goal,
        )
        shard = ShardContext(
            goal=goal,
            constraints=[f"max_parallel<={mp}", "子任务独立交付"],
            acceptance=["可聚合", "精炼结论"],
            shared_brief=f"SkillPack={pack}; KB={self.settings.data_source}",
        )

        kb_block = _kb_context(self.settings, goal)
        if kb_block:
            store.append_event(
                run_id,
                "决策点",
                task="知识库检索",
                actor="knowledge",
                inputs=[self.settings.data_source],
                outputs=[kb_block[:240]],
            )

        # Split
        tasks = self._split(goal, mp)
        store.append_event(
            run_id,
            "并行触发",
            task="STORM Split",
            actor="Orchestrator",
            outputs=tasks,
            metrics={"子任务数": len(tasks)},
            notes=str(shard.orchestrator_view()),
        )
        logger.info("run_id=%s Split → %s 个子任务", run_id, len(tasks))

        # Triage + Orchestrate (parallel)
        t0 = time.time()
        results: dict[str, str] = {}

        def _exec_one(task: str) -> tuple[str, str]:
            ctx = shard.for_subagent(task)
            out = self.llm.complete(
                _with_kb(
                    f"共享上下文：{ctx['shared']}\n验收：{ctx['acceptance']}\n"
                    f"请独立完成任务并只返回精炼结论（不要过程噪音）：\n{task}",
                    kb_block,
                ),
                role="subagent",
                system="你是 Sub-agent，冻结能力，只交付结论。",
            )
            return task, out

        with ThreadPoolExecutor(max_workers=min(mp, len(tasks))) as pool:
            futures = [pool.submit(_exec_one, t) for t in tasks]
            for fut in as_completed(futures):
                try:
                    task, out = fut.result()
                except Exception as exc:  # noqa: BLE001
                    store.append_event(
                        run_id,
                        "失败",
                        task="子任务失败",
                        actor="subagent",
                        notes=str(exc),
                    )
                    raise ExecFailError(f"Swarm 子任务失败: {exc}") from exc
                results[task] = out
                store.append_event(
                    run_id,
                    "完成",
                    task=task,
                    actor="subagent",
                    outputs=[out[:200]],
                )
                logger.info("run_id=%s 子任务完成: %s", run_id, task[:40])

        elapsed = time.time() - t0
        # Rollup
        sections = "\n\n".join(f"### {k}\n{v}" for k, v in results.items())
        rollup = self.llm.complete(
            _with_kb(
                f"目标：{goal}\n聚合以下并行子任务结论为最终交付报告：\n{sections}",
                kb_block,
            ),
            role="orchestrator",
            system="Orchestrator Rollup：唯一交付面，去重冲突并标注。",
        )
        body = (
            f"# Swarm 交付\n\n**目标**：{goal}\n\n"
            f"**Critical Path 近似耗时**：{elapsed:.2f}s（并行墙钟）\n\n"
            f"## 聚合报告\n\n{rollup}\n\n## 子任务结论\n\n{sections}\n"
        )
        delivery = Delivery(title=f"Swarm：{goal[:40]}", body_markdown=body)
        if not rollup.strip():
            raise NoDeliveryError("Swarm Rollup 为空")

        store.append_event(
            run_id,
            "完成",
            task="STORM Rollup+Monitor",
            actor="Orchestrator",
            outputs=[delivery.title],
            metrics={"墙钟秒": round(elapsed, 2), "并行度": len(tasks)},
        )
        result = RunResult(
            run_id=run_id,
            module=module,
            mode="swarm",
            coordinator="Orchestrator",
            delivery=delivery,
            data_source=self.settings.data_source,
            meta={
                "pack": pack,
                "tasks": tasks,
                "max_parallel": mp,
                "wall_clock_sec": round(elapsed, 2),
                "context_shard": shard.orchestrator_view(),
                "knowledge_base": self.settings.data_source,
                "llm_mode": self.settings.llm_mode,
            },
        )
        store.save_result(result)
        return result
