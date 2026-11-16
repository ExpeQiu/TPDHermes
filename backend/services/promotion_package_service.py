"""技术推广包：评估、确认、生成、审核与打包。"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import time
import uuid
import zipfile
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.promotion_package import (
    PromotionPackage,
    PromotionPackageReview,
    PromotionPackageStep,
)
from backend.services.file_action_service import FileActionConflict, _claim_output_version
from backend.services.project_access import project_owner_id, require_project_for_user
from backend.services.project_files_service import get_project_file_detail
from backend.services.project_member_service import get_project_role
from backend.services.promotion_quality import (
    FIELDS,
    PRODUCT_FILES,
    PRODUCT_TITLES,
    PRODUCTS,
    TEMPLATE_VERSION,
    append_citations,
    assess_documents,
    blocked_by_facts,
    build_search_query,
    changed_fact_ids,
    cited_fact_ids,
    corpus_token,
    brief_fingerprint,
    fact_fingerprint,
    invalidate_products,
    safe_zip_name,
    skill_context,
)
from backend.services.skill_loader import get_loader
from backend.services.user_identity import is_global_admin_user

logger = logging.getLogger("tpdx.hermes.promotion")

LEASE_SEC = 120
MAX_EXPORT_FILES = 10
MAX_EXPORT_BYTES = 5 * 1024 * 1024
STEP_PENDING = "pending"
STEP_RUNNING = "running"
STEP_WAIT = "awaiting_human"
STEP_OK = "succeeded"
STEP_FAIL = "failed"


class PromotionError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(detail)


def _now() -> str:
    return datetime.now().isoformat()


def _loads(raw: str | None, fallback: Any) -> Any:
    try:
        return json.loads(raw or "")
    except json.JSONDecodeError:
        return fallback


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


async def public_search(query: str) -> list[dict[str, Any]]:
    """默认可替换的公开检索。未配置外部检索时返回空列表，不抛网络错误。"""
    _ = query
    return []


def _lease_deadline() -> str:
    return (datetime.now() + timedelta(seconds=LEASE_SEC)).isoformat()


async def _role(db: AsyncSession, project_id: str, user_id: str, project) -> str:
    if is_global_admin_user(user_id):
        return "owner"
    role = await get_project_role(db, project_id=project_id, user_id=user_id, project=project)
    return role or ""


async def _load_package(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    min_perm: str,
) -> tuple[PromotionPackage, Any, str]:
    project = await require_project_for_user(db, project_id, user_id, min_perm=min_perm)
    row = await db.get(PromotionPackage, package_id)
    if not row or row.project_id != project_id:
        raise PromotionError(404, "Not found")
    role = await _role(db, project_id, user_id, project)
    return row, project, role


def _check_revision(row: PromotionPackage, expected: int) -> None:
    if int(expected) != int(row.revision or 0):
        raise PromotionError(409, f"revision_conflict: current={row.revision}")


def _touch(row: PromotionPackage) -> None:
    row.revision = int(row.revision or 0) + 1
    row.updated_at = _now()


def _empty_products(names: list[str]) -> dict[str, Any]:
    return {
        name: {"head_output_id": "", "status": "idle", "versions": []}
        for name in names
    }


async def create_package(
    db: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    idempotency_key: str,
    file_refs: list[dict[str, str]],
    products: list[str],
) -> dict[str, Any]:
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    key = idempotency_key.strip()
    if len(key) < 8:
        raise PromotionError(400, "idempotency_key 过短")
    names = _normalize_products(products)
    if not file_refs:
        raise PromotionError(400, "至少选择一个项目文件")
    existing = (
        await db.execute(
            select(PromotionPackage).where(
                PromotionPackage.project_id == project_id,
                PromotionPackage.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()
    if existing:
        logger.info(
            "promotion create replay package_id=%s project_id=%s",
            existing.id,
            project_id,
        )
        return await _detail(db, existing, role="editor", replayed=True)
    row = PromotionPackage(
        id=str(uuid.uuid4()),
        project_id=project_id,
        idempotency_key=key,
        status="draft",
        created_by=user_id,
        product_types_json=_dumps(names),
        file_refs_json=_dumps(file_refs),
        snapshot_json="[]",
        assessment_json=_dumps({"fields": [], "candidates": [], "blocked_products": []}),
        brief_json=_dumps({}),
        facts_json="[]",
        products_json=_dumps(_empty_products(names)),
        brief_version=0,
        facts_version=0,
        revision=1,
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = (
            await db.execute(
                select(PromotionPackage).where(
                    PromotionPackage.project_id == project_id,
                    PromotionPackage.idempotency_key == key,
                )
            )
        ).scalar_one_or_none()
        if existing:
            return await _detail(db, existing, role="editor", replayed=True)
        raise
    logger.info(
        "promotion create package_id=%s project_id=%s products=%s",
        row.id,
        project_id,
        ",".join(names),
    )
    return await _detail(db, row, role="editor", replayed=False)


async def list_packages(db: AsyncSession, *, project_id: str, user_id: str) -> list[dict[str, Any]]:
    await require_project_for_user(db, project_id, user_id, min_perm="read")
    rows = (
        await db.execute(
            select(PromotionPackage)
            .where(PromotionPackage.project_id == project_id)
            .order_by(PromotionPackage.created_at.desc())
        )
    ).scalars().all()
    return [_summary(row) for row in rows]


async def get_package(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
) -> dict[str, Any]:
    row, _project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="read"
    )
    return await _detail(db, row, role=role, replayed=False)


async def assess_package(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    expected_revision: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    row, _project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="write"
    )
    _check_revision(row, expected_revision)
    await recover_expired_steps(db, package_id=row.id)
    documents = await _read_snapshot_docs(db, row)
    selected = _loads(row.product_types_json, [])
    assessment = assess_documents(documents, selected=selected)
    search_error = ""
    query = build_search_query(assessment["fields"])
    try:
        found = await public_search(query)
    except Exception as exc:  # noqa: BLE001
        found = []
        search_error = type(exc).__name__
        logger.info(
            "promotion search failed package_id=%s project_id=%s step=search error_type=%s elapsed_ms=%s",
            row.id,
            project_id,
            search_error,
            int((time.perf_counter() - started) * 1000),
        )
    for item in found:
        if not isinstance(item, dict):
            continue
        assessment["candidates"].append(
            {
                "origin": "web",
                "claim": str(item.get("claim") or "comparison"),
                "value": str(item.get("value") or ""),
                "visibility": "public",
                "source": {
                    "doc_id": "",
                    "locator": str(item.get("url") or ""),
                    "url": str(item.get("url") or ""),
                    "file_id": "",
                },
            }
        )
    for index, candidate in enumerate(assessment["candidates"], start=1):
        candidate["id"] = candidate.get("id") or f"cand_{index}"
        candidate["adopted"] = False
    row.snapshot_json = _dumps(
        [
            {
                "file_id": doc["file_id"],
                "kind": doc["kind"],
                "title": doc["title"],
                "version": doc["version"],
                "digest": doc["digest"],
                "parse_status": doc["parse_status"],
                "template_version": TEMPLATE_VERSION,
                "created_by": row.created_by,
            }
            for doc in documents
        ]
    )
    row.assessment_json = _dumps(assessment)
    row.status = "awaiting_human" if assessment["blocked_products"] or search_error else "assessed"
    _touch(row)
    await _upsert_step(
        db,
        row=row,
        step_key="assess",
        input_version=corpus_token(row.brief_version, row.facts_version),
        status=STEP_OK,
        error_type="",
        error_message="",
        output_id="",
    )
    await _upsert_step(
        db,
        row=row,
        step_key="search",
        input_version=corpus_token(row.brief_version, row.facts_version),
        status=STEP_FAIL if search_error else STEP_OK,
        error_type=search_error,
        error_message="",
        output_id="",
    )
    await db.commit()
    logger.info(
        "promotion assess package_id=%s project_id=%s step=assess status=%s elapsed_ms=%s error_type=%s",
        row.id,
        project_id,
        row.status,
        int((time.perf_counter() - started) * 1000),
        search_error,
    )
    return await _detail(db, row, role=role, replayed=False)


async def confirm_facts(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    expected_revision: int,
    goal: str,
    audience: str,
    summary: str,
    facts: list[dict[str, Any]],
    adopted_candidate_ids: list[str],
) -> dict[str, Any]:
    row, _project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="write"
    )
    _check_revision(row, expected_revision)
    assessment = _loads(row.assessment_json, {})
    candidates = {str(item.get("id")): item for item in assessment.get("candidates") or []}
    adopted = set(adopted_candidate_ids)
    previous_facts = _loads(row.facts_json, [])
    previous_brief = _loads(row.brief_json, {})
    cleaned: list[dict[str, Any]] = []
    for item in facts:
        origin = str(item.get("source_type") or "human")
        candidate_id = str(item.get("candidate_id") or "")
        if origin in {"kb", "web"}:
            candidate = candidates.get(candidate_id)
            if candidate_id not in adopted or not candidate:
                raise PromotionError(400, "知识库和联网证据需人工采纳后才能确认")
            if candidate.get("origin") != origin:
                raise PromotionError(400, "候选来源与事实来源不一致")
        claim = str(item.get("claim") or "")
        if claim not in {field["key"] for field in FIELDS}:
            raise PromotionError(400, f"未知事实字段 {claim}")
        fact_id = str(item.get("id") or "").strip() or f"fact_{uuid.uuid4().hex[:12]}"
        cleaned.append(
            {
                "id": fact_id,
                "claim": claim,
                "value": str(item.get("value") or "").strip(),
                "unit": str(item.get("unit") or "").strip(),
                "conditions": str(item.get("conditions") or "").strip(),
                "visibility": "public" if str(item.get("visibility") or "") == "public" else "project",
                "source_type": origin,
                "source_ref": str(item.get("source_ref") or candidate_id),
                "candidate_id": candidate_id,
                "confirmed_by": user_id,
            }
        )
    brief_changed = bool(previous_brief) and (
        str(previous_brief.get("goal") or "") != goal.strip()
        or str(previous_brief.get("audience") or "") != audience.strip()
    )
    changed = changed_fact_ids(previous_facts, cleaned) if previous_facts else []
    row.brief_version = int(row.brief_version or 0) + 1
    row.facts_version = int(row.facts_version or 0) + 1
    row.brief_json = _dumps(
        {
            "goal": goal.strip(),
            "audience": audience.strip(),
            "summary": summary.strip(),
            "version": row.brief_version,
            "confirmed_by": user_id,
        }
    )
    row.facts_json = _dumps(cleaned)
    products = _loads(row.products_json, {})
    if changed or brief_changed:
        products = invalidate_products(products, changed_ids=changed, brief_changed=brief_changed)
        row.products_json = _dumps(products)
    for candidate in assessment.get("candidates") or []:
        candidate["adopted"] = str(candidate.get("id")) in adopted
    row.assessment_json = _dumps(assessment)
    row.status = "confirmed"
    _touch(row)
    await _upsert_step(
        db,
        row=row,
        step_key="confirm",
        input_version=corpus_token(row.brief_version, row.facts_version),
        status=STEP_OK,
        error_type="",
        error_message="",
        output_id="",
    )
    await db.commit()
    logger.info(
        "promotion confirm package_id=%s project_id=%s step=confirm facts=%s elapsed_ms=0 error_type=%s",
        row.id,
        project_id,
        len(cleaned),
        "brief_changed" if brief_changed else "",
    )
    return await _detail(db, row, role=role, replayed=False)


async def generate_package(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    expected_revision: int,
    products: list[str] | None,
) -> dict[str, Any]:
    started = time.perf_counter()
    row, _project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="write"
    )
    _check_revision(row, expected_revision)
    if int(row.brief_version or 0) < 1:
        raise PromotionError(400, "请先确认推广简报和事实")
    selected = _normalize_products(products or _loads(row.product_types_json, []))
    stored = _loads(row.product_types_json, [])
    added = [name for name in selected if name not in stored]
    if added:
        row.product_types_json = _dumps([*stored, *added])
        logger.info(
            "promotion adopt products package_id=%s project_id=%s products=%s",
            row.id,
            project_id,
            ",".join(added),
        )
    facts = _loads(row.facts_json, [])
    blocked = {item["product"]: item["missing"] for item in blocked_by_facts(facts, selected)}
    await recover_expired_steps(db, package_id=row.id)
    brief = _loads(row.brief_json, {})
    token = corpus_token(row.brief_version, row.facts_version)
    state = _loads(row.products_json, {})
    for name in added:
        state.setdefault(name, {"head_output_id": "", "status": "idle", "versions": []})
    for name in selected:
        if name in blocked:
            await _upsert_step(
                db,
                row=row,
                step_key=f"generate:{name}",
                input_version=token,
                status=STEP_FAIL,
                error_type="blocked",
                error_message=",".join(blocked[name]),
                output_id="",
            )
            continue
        step = await _claim_step(db, row=row, step_key=f"generate:{name}", input_version=token)
        if step.status == STEP_OK and step.output_id:
            continue
        outcome = await _run_skill(name, skill_context(name, facts, brief))
        if outcome["error_type"]:
            step.status = STEP_FAIL
            step.error_type = outcome["error_type"]
            step.error_message = outcome["error_type"]
            step.finished_at = _now()
            step.updated_at = step.finished_at
            step.lease_until = None
            logger.info(
                "promotion generate package_id=%s project_id=%s step=%s status=failed elapsed_ms=%s error_type=%s",
                row.id,
                project_id,
                step.step_key,
                outcome["elapsed_ms"],
                outcome["error_type"],
            )
            continue
        fact_ids = cited_fact_ids(name, facts)
        content = append_citations(outcome["content"], facts, fact_ids)
        output = _new_output(
            project_id=project_id,
            user_id=user_id,
            title=PRODUCT_TITLES[name],
            content=content,
            version="1",
            lineage_id="",
            fact_ids=fact_ids,
            facts_version=int(row.facts_version or 0),
            brief_version=int(row.brief_version or 0),
            package_id=row.id,
            product=name,
        )
        output.lineage_id = output.id
        db.add(output)
        version = {
            "output_id": output.id,
            "version": output.version,
            "status": "draft",
            "fact_ids": fact_ids,
            "fingerprint": fact_fingerprint(facts, fact_ids),
            "brief_fingerprint": brief_fingerprint(brief),
            "facts_version": int(row.facts_version or 0),
            "brief_version": int(row.brief_version or 0),
            "skill_version": outcome["skill_version"],
        }
        product_state = state.setdefault(name, {"head_output_id": "", "status": "idle", "versions": []})
        product_state["versions"] = [
            item for item in product_state.get("versions") or [] if item.get("output_id") != output.id
        ]
        product_state["versions"].append(version)
        product_state["head_output_id"] = output.id
        product_state["status"] = "draft"
        step.status = STEP_OK
        step.output_id = output.id
        step.error_type = ""
        step.error_message = ""
        step.finished_at = _now()
        step.updated_at = step.finished_at
        step.lease_until = None
        logger.info(
            "promotion generate package_id=%s project_id=%s step=%s status=succeeded elapsed_ms=%s error_type=",
            row.id,
            project_id,
            step.step_key,
            outcome["elapsed_ms"],
        )
    row.products_json = _dumps(state)
    row.status = "reviewing"
    _touch(row)
    await db.commit()
    logger.info(
        "promotion generate done package_id=%s project_id=%s step=generate status=%s elapsed_ms=%s error_type=",
        row.id,
        project_id,
        row.status,
        int((time.perf_counter() - started) * 1000),
    )
    return await _detail(db, row, role=role, replayed=False)


async def revise_output(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    expected_revision: int,
    output_id: str,
    expected_version: str,
    content: str,
    fact_ids: list[str],
) -> dict[str, Any]:
    row, _project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="write"
    )
    _check_revision(row, expected_revision)
    facts = _loads(row.facts_json, [])
    known = {str(fact.get("id")) for fact in facts}
    if any(fact_id not in known for fact_id in fact_ids):
        raise PromotionError(400, "引用了本批确认事实之外的条目")
    state = _loads(row.products_json, {})
    product, version = _find_version(state, output_id)
    if version.get("output_id") != state[product].get("head_output_id"):
        raise PromotionError(409, "version_conflict: 只能修订当前出品版本")
    current = await db.get(OutputAsset, output_id)
    if not current or current.project_id != project_id:
        raise PromotionError(404, "Not found")
    try:
        await _claim_output_version(
            db,
            file_id=output_id,
            project_id=project_id,
            version=str(expected_version),
        )
    except FileActionConflict as exc:
        raise PromotionError(409, f"version_conflict: current={exc.current_version}") from exc
    next_version = str(int(str(current.version or "1")) + 1)
    created = _new_output(
        project_id=project_id,
        user_id=user_id,
        title=current.title or PRODUCT_TITLES.get(product, "推广稿"),
        content=content,
        version=next_version,
        lineage_id=str(current.lineage_id or current.id),
        fact_ids=fact_ids,
        facts_version=int(row.facts_version or 0),
        brief_version=int(row.brief_version or 0),
        package_id=row.id,
        product=product,
    )
    db.add(created)
    entry = {
        "output_id": created.id,
        "version": created.version,
        "status": "draft",
        "fact_ids": fact_ids,
        "fingerprint": fact_fingerprint(facts, fact_ids),
        "brief_fingerprint": brief_fingerprint(_loads(row.brief_json, {})),
        "facts_version": int(row.facts_version or 0),
        "brief_version": int(row.brief_version or 0),
        "skill_version": version.get("skill_version") or "",
    }
    state[product]["versions"].append(entry)
    state[product]["head_output_id"] = created.id
    state[product]["status"] = "draft"
    row.products_json = _dumps(state)
    _touch(row)
    await db.commit()
    logger.info(
        "promotion revise package_id=%s project_id=%s step=revise status=draft elapsed_ms=0 error_type=",
        row.id,
        project_id,
    )
    return await _detail(db, row, role=role, replayed=False)


async def review_output(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    expected_revision: int,
    output_id: str,
    expected_version: str,
    action: str,
    comment: str,
) -> dict[str, Any]:
    row, project, role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="write"
    )
    _check_revision(row, expected_revision)
    if action == "approve" and role != "owner" and project_owner_id(project) != user_id:
        raise PromotionError(403, "仅项目负责人可审批")
    if action not in {"submit", "reject", "approve"}:
        raise PromotionError(400, "未知审核动作")
    if action == "reject" and not comment.strip():
        raise PromotionError(400, "退回需要填写意见")
    state = _loads(row.products_json, {})
    product, version = _find_version(state, output_id)
    if output_id != state[product].get("head_output_id"):
        raise PromotionError(409, "version_conflict: 审核对象不是当前版本")
    current = await db.get(OutputAsset, output_id)
    if not current or current.project_id != project_id:
        raise PromotionError(404, "Not found")
    if str(current.version or "") != str(expected_version):
        raise PromotionError(409, f"version_conflict: current={current.version}")
    facts = _loads(row.facts_json, [])
    live_fp = fact_fingerprint(facts, list(version.get("fact_ids") or []))
    live_brief = brief_fingerprint(_loads(row.brief_json, {}))
    stale = live_fp != version.get("fingerprint") or live_brief != version.get("brief_fingerprint")
    status = str(version.get("status") or "")
    if action == "submit":
        if status not in {"draft", "rejected", "needs_rereview"}:
            raise PromotionError(409, "当前状态不能送审")
        if stale:
            raise PromotionError(409, "facts_changed: 请先按新口径修订后再送审")
        version["status"] = "pending_review"
    elif action == "reject":
        if status != "pending_review":
            raise PromotionError(409, "当前状态不能退回")
        version["status"] = "rejected"
    else:
        if status != "pending_review" or stale:
            raise PromotionError(409, "facts_changed: 审核已失效")
        version["status"] = "approved"
        version["fingerprint"] = live_fp
    state[product]["status"] = version["status"]
    row.products_json = _dumps(state)
    db.add(
        PromotionPackageReview(
            id=str(uuid.uuid4()),
            package_id=row.id,
            project_id=project_id,
            output_id=output_id,
            output_version=str(current.version or ""),
            product=product,
            action=action,
            comment=comment.strip(),
            actor_id=user_id,
            fact_ids_json=_dumps(list(version.get("fact_ids") or [])),
            facts_version=int(row.facts_version or 0),
            brief_version=int(row.brief_version or 0),
            created_at=_now(),
        )
    )
    _touch(row)
    await db.commit()
    logger.info(
        "promotion review package_id=%s project_id=%s step=review status=%s elapsed_ms=0 error_type=",
        row.id,
        project_id,
        version["status"],
    )
    return await _detail(db, row, role=role, replayed=False)


async def export_package(
    db: AsyncSession,
    *,
    project_id: str,
    package_id: str,
    user_id: str,
    output_ids: list[str],
) -> tuple[str, bytes]:
    row, _project, _role = await _load_package(
        db, project_id=project_id, package_id=package_id, user_id=user_id, min_perm="read"
    )
    if not output_ids:
        raise PromotionError(400, "请选择要导出的版本")
    if len(output_ids) > MAX_EXPORT_FILES:
        raise PromotionError(400, "导出文件数量超过限制")
    state = _loads(row.products_json, {})
    facts = _loads(row.facts_json, [])
    conflicts: list[str] = []
    chosen: list[tuple[str, dict[str, Any], OutputAsset]] = []
    seen: set[str] = set()
    for output_id in output_ids:
        if output_id in seen:
            continue
        seen.add(output_id)
        try:
            product, version = _find_version(state, output_id)
        except PromotionError:
            conflicts.append(f"output_id={output_id} reason=not_in_package")
            continue
        current = await db.get(OutputAsset, output_id)
        if not current or current.project_id != project_id:
            conflicts.append(f"output_id={output_id} reason=not_in_project")
            continue
        live_fp = fact_fingerprint(facts, list(version.get("fact_ids") or []))
        live_brief = brief_fingerprint(_loads(row.brief_json, {}))
        if live_fp != version.get("fingerprint") or live_brief != version.get("brief_fingerprint"):
            conflicts.append(
                f"output_id={output_id} reason=facts_changed fact_ids={','.join(version.get('fact_ids') or [])}"
            )
            continue
        if version.get("status") != "approved":
            conflicts.append(f"output_id={output_id} reason=not_approved")
            continue
        chosen.append((product, version, current))
    if conflicts:
        logger.info(
            "promotion export conflict package_id=%s project_id=%s step=export status=conflict elapsed_ms=0 error_type=export_conflict",
            row.id,
            project_id,
        )
        raise PromotionError(409, "export_conflict: " + " | ".join(conflicts))
    used: dict[str, int] = {}
    manifest_items: list[dict[str, Any]] = []
    blob = io.BytesIO()
    with zipfile.ZipFile(blob, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for product, version, current in chosen:
            filename = PRODUCT_FILES.get(product, f"{product}.md")
            filename = safe_zip_name(filename)
            if filename in used:
                stem, dot, ext = filename.rpartition(".")
                filename = f"{stem}-v{version.get('version')}-{str(current.id)[:6]}.{ext or 'md'}"
            used[filename] = 1
            body = (current.content or "").encode("utf-8")
            archive.writestr(filename, body)
            public_ids = {
                str(fact.get("id"))
                for fact in facts
                if fact.get("visibility") == "public" and str(fact.get("id")) in set(version.get("fact_ids") or [])
            }
            manifest_items.append(
                {
                    "product": product,
                    "name": PRODUCT_TITLES.get(product, product),
                    "version": version.get("version"),
                    "filename": filename,
                    "output_id": current.id,
                    "public_citations": [
                        {"fact_id": fact.get("id"), "claim": fact.get("claim"), "value": fact.get("value")}
                        for fact in facts
                        if str(fact.get("id")) in public_ids
                    ],
                }
            )
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "package_id": row.id,
                    "project_id": project_id,
                    "exported_at": _now(),
                    "items": manifest_items,
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
    data = blob.getvalue()
    if len(data) > MAX_EXPORT_BYTES:
        raise PromotionError(400, "导出体积超过限制")
    logger.info(
        "promotion export package_id=%s project_id=%s step=export status=ok elapsed_ms=0 error_type= files=%s",
        row.id,
        project_id,
        len(manifest_items),
    )
    return f"promotion-{row.id[:8]}.zip", data


async def recover_expired_steps(db: AsyncSession, *, package_id: str) -> int:
    now = _now()
    result = await db.execute(
        update(PromotionPackageStep)
        .where(
            PromotionPackageStep.package_id == package_id,
            PromotionPackageStep.status == STEP_RUNNING,
            or_(
                PromotionPackageStep.lease_until.is_(None),
                PromotionPackageStep.lease_until <= now,
            ),
        )
        .values(status=STEP_PENDING, lease_until=None, updated_at=now)
    )
    count = int(result.rowcount or 0)
    if count:
        logger.info(
            "promotion recover package_id=%s project_id= step=recover status=pending elapsed_ms=0 error_type= count=%s",
            package_id,
            count,
        )
    return count


def _normalize_products(products: list[str]) -> list[str]:
    names: list[str] = []
    for name in products:
        if name not in PRODUCTS:
            raise PromotionError(400, f"不支持的出品 {name}")
        if name not in names:
            names.append(name)
    if not names:
        raise PromotionError(400, "至少选择一种出品")
    return names


async def _read_snapshot_docs(db: AsyncSession, row: PromotionPackage) -> list[dict[str, Any]]:
    import hashlib

    docs: list[dict[str, Any]] = []
    for ref in _loads(row.file_refs_json, []):
        file_id = str(ref.get("file_id") or "")
        kind = str(ref.get("kind") or "attachment")
        detail = await get_project_file_detail(db, row.project_id, file_id, kind)
        if not detail:
            raise PromotionError(400, "所选文件不存在")
        content = str(detail.get("content") or "")
        unreadable = content.startswith("（") or str(detail.get("status") or "") in {"failed", "error"}
        docs.append(
            {
                "file_id": file_id,
                "kind": kind,
                "title": detail.get("title") or file_id,
                "version": str(detail.get("version") or ""),
                "digest": hashlib.sha256(content.encode()).hexdigest()[:16],
                "parse_status": "failed" if unreadable else "ok",
                "parse_error": content[:80] if unreadable else "",
                "content": "" if unreadable else content,
            }
        )
    return docs


async def _claim_step(
    db: AsyncSession,
    *,
    row: PromotionPackage,
    step_key: str,
    input_version: str,
) -> PromotionPackageStep:
    existing = (
        await db.execute(
            select(PromotionPackageStep).where(
                PromotionPackageStep.package_id == row.id,
                PromotionPackageStep.step_key == step_key,
                PromotionPackageStep.input_version == input_version,
            )
        )
    ).scalar_one_or_none()
    now = _now()
    if existing and existing.status == STEP_OK and existing.output_id:
        return existing
    worker = str(uuid.uuid4())
    if existing is None:
        existing = PromotionPackageStep(
            id=str(uuid.uuid4()),
            package_id=row.id,
            project_id=row.project_id,
            step_key=step_key,
            input_version=input_version,
            status=STEP_RUNNING,
            attempt=1,
            worker_id=worker,
            lease_until=_lease_deadline(),
            started_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(existing)
        await db.flush()
        return existing
    result = await db.execute(
        update(PromotionPackageStep)
        .where(
            PromotionPackageStep.id == existing.id,
            or_(
                PromotionPackageStep.status.in_([STEP_PENDING, STEP_FAIL, STEP_WAIT]),
                PromotionPackageStep.lease_until.is_(None),
                PromotionPackageStep.lease_until <= now,
            ),
        )
        .values(
            status=STEP_RUNNING,
            attempt=int(existing.attempt or 0) + 1,
            worker_id=worker,
            lease_until=_lease_deadline(),
            error_type="",
            error_message="",
            started_at=now,
            updated_at=now,
        )
    )
    await db.flush()
    await db.refresh(existing)
    if result.rowcount == 0 or existing.worker_id != worker:
        if existing.status == STEP_OK and existing.output_id:
            return existing
        raise PromotionError(409, "step_running")
    return existing


async def _upsert_step(
    db: AsyncSession,
    *,
    row: PromotionPackage,
    step_key: str,
    input_version: str,
    status: str,
    error_type: str,
    error_message: str,
    output_id: str,
) -> None:
    existing = (
        await db.execute(
            select(PromotionPackageStep).where(
                PromotionPackageStep.package_id == row.id,
                PromotionPackageStep.step_key == step_key,
                PromotionPackageStep.input_version == input_version,
            )
        )
    ).scalar_one_or_none()
    now = _now()
    if existing and existing.status == STEP_OK and step_key.startswith("generate:"):
        return
    if existing is None:
        db.add(
            PromotionPackageStep(
                id=str(uuid.uuid4()),
                package_id=row.id,
                project_id=row.project_id,
                step_key=step_key,
                input_version=input_version,
                status=status,
                attempt=1,
                error_type=error_type or None,
                error_message=error_message or None,
                output_id=output_id or None,
                finished_at=now,
                created_at=now,
                updated_at=now,
            )
        )
        return
    existing.status = status
    existing.error_type = error_type or None
    existing.error_message = error_message or None
    existing.output_id = output_id or existing.output_id
    existing.finished_at = now
    existing.updated_at = now
    existing.lease_until = None


async def _run_skill(product: str, context: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        skill = get_loader().load(product)
        result = await asyncio.to_thread(skill.generate, context)
    except Exception as exc:  # noqa: BLE001
        logger.info(
            "promotion skill package_id= project_id= step=%s status=failed elapsed_ms=%s error_type=%s",
            product,
            int((time.perf_counter() - started) * 1000),
            type(exc).__name__,
        )
        return {
            "content": "",
            "skill_version": "",
            "error_type": type(exc).__name__,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
    content = ""
    if isinstance(result, dict):
        content = str(result.get("content") or "")
    if not content.strip():
        return {"content": "", "skill_version": "", "error_type": "empty_output", "elapsed_ms": 0}
    return {
        "content": content,
        "skill_version": str(getattr(skill, "loaded_version", "") or "unknown"),
        "error_type": "",
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }


def _new_output(
    *,
    project_id: str,
    user_id: str,
    title: str,
    content: str,
    version: str,
    lineage_id: str,
    fact_ids: list[str],
    facts_version: int,
    brief_version: int,
    package_id: str,
    product: str,
) -> OutputAsset:
    now = _now()
    return OutputAsset(
        id=str(uuid.uuid4()),
        project_id=project_id,
        title=title,
        summary=PRODUCT_TITLES.get(product, title),
        content=content,
        content_format="markdown",
        version=version,
        lineage_id=lineage_id or None,
        status="draft",
        citations_json=_dumps(
            {
                "package_id": package_id,
                "product": product,
                "fact_ids": fact_ids,
                "facts_version": facts_version,
                "brief_version": brief_version,
            }
        ),
        owner_id=user_id,
        created_at=now,
        updated_at=now,
    )


def _find_version(state: dict[str, Any], output_id: str) -> tuple[str, dict[str, Any]]:
    for product, product_state in state.items():
        for version in product_state.get("versions") or []:
            if version.get("output_id") == output_id:
                return product, version
    raise PromotionError(404, "Not found")


def _summary(row: PromotionPackage) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "status": row.status,
        "products": _loads(row.product_types_json, []),
        "revision": row.revision,
        "brief_version": row.brief_version,
        "facts_version": row.facts_version,
        "created_by": row.created_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _actions(row: PromotionPackage, role: str, state: dict[str, Any]) -> dict[str, Any]:
    writable = role in {"owner", "editor"}
    return {
        "assess": writable,
        "confirm": writable,
        "generate": writable and int(row.brief_version or 0) > 0,
        "approve": role == "owner",
        "export": role in {"owner", "editor", "viewer"},
        "products": {
            name: {
                "revise": writable and bool(item.get("head_output_id")),
                "submit": writable and item.get("status") in {"draft", "rejected", "needs_rereview"},
                "reject": writable and item.get("status") == "pending_review",
                "approve": role == "owner" and item.get("status") == "pending_review",
            }
            for name, item in state.items()
        },
    }


async def _detail(db: AsyncSession, row: PromotionPackage, *, role: str, replayed: bool) -> dict[str, Any]:
    steps = (
        await db.execute(
            select(PromotionPackageStep)
            .where(PromotionPackageStep.package_id == row.id)
            .order_by(PromotionPackageStep.created_at.asc())
        )
    ).scalars().all()
    reviews = (
        await db.execute(
            select(PromotionPackageReview)
            .where(PromotionPackageReview.package_id == row.id)
            .order_by(PromotionPackageReview.created_at.asc())
        )
    ).scalars().all()
    state = _loads(row.products_json, {})
    contents: dict[str, str] = {}
    for product_state in state.values():
        for version in product_state.get("versions") or []:
            output_id = str(version.get("output_id") or "")
            if not output_id or output_id in contents:
                continue
            asset = await db.get(OutputAsset, output_id)
            if asset and asset.project_id == row.project_id:
                contents[output_id] = asset.content or ""
                version["content"] = contents[output_id]
    return {
        **_summary(row),
        "replayed": replayed,
        "file_refs": _loads(row.file_refs_json, []),
        "snapshot": _loads(row.snapshot_json, []),
        "assessment": _loads(row.assessment_json, {}),
        "brief": _loads(row.brief_json, {}),
        "facts": _loads(row.facts_json, []),
        "products_state": state,
        "role": role,
        "actions": _actions(row, role, state),
        "steps": [
            {
                "id": step.id,
                "step_key": step.step_key,
                "input_version": step.input_version,
                "status": step.status,
                "attempt": step.attempt,
                "error_type": step.error_type or "",
                "output_id": step.output_id or "",
            }
            for step in steps
        ],
        "reviews": [
            {
                "id": item.id,
                "output_id": item.output_id,
                "output_version": item.output_version,
                "product": item.product,
                "action": item.action,
                "comment": item.comment,
                "actor_id": item.actor_id,
                "created_at": item.created_at,
            }
            for item in reviews
        ],
    }
