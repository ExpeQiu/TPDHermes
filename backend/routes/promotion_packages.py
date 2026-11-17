"""项目技术推广包。"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.promotion_package_service import (
    PromotionError,
    assess_package,
    confirm_facts,
    create_package,
    export_package,
    generate_package,
    save_package_to_project,
    get_package,
    list_packages,
    review_output,
    revise_output,
)
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/projects", tags=["promotion-packages"])


class FileRefBody(BaseModel):
    file_id: str
    kind: str = "attachment"


class PackageCreateBody(BaseModel):
    idempotency_key: str
    file_refs: list[FileRefBody] = Field(default_factory=list)
    products: list[str] = Field(default_factory=list)


class RevisionBody(BaseModel):
    expected_revision: int
    fill: bool = False


class FactBody(BaseModel):
    id: str = ""
    claim: str
    value: str
    unit: str = ""
    conditions: str = ""
    visibility: str = "project"
    source_type: str = "human"
    source_ref: str = ""
    candidate_id: str = ""


class ConfirmBody(RevisionBody):
    goal: str
    audience: str
    summary: str = ""
    facts: list[FactBody] = Field(default_factory=list)
    adopted_candidate_ids: list[str] = Field(default_factory=list)


class GenerateBody(RevisionBody):
    products: list[str] = Field(default_factory=list)


class ReviseBody(RevisionBody):
    output_id: str
    expected_version: str
    content: str
    fact_ids: list[str] = Field(default_factory=list)


class ReviewBody(RevisionBody):
    output_id: str
    expected_version: str
    action: str
    comment: str = ""


class ExportBody(BaseModel):
    output_ids: list[str] = Field(default_factory=list)


def _raise(exc: PromotionError) -> None:
    from fastapi import HTTPException

    raise HTTPException(status_code=exc.status, detail=exc.detail)


@router.get("/{project_id}/promotion-packages")
async def api_list_packages(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        items = await list_packages(db, project_id=project_id, user_id=user_id)
    except PromotionError as exc:
        _raise(exc)
    return {"items": items}


@router.post("/{project_id}/promotion-packages")
async def api_create_package(
    project_id: str,
    body: PackageCreateBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await create_package(
            db,
            project_id=project_id,
            user_id=user_id,
            idempotency_key=body.idempotency_key,
            file_refs=[item.model_dump() for item in body.file_refs],
            products=body.products,
        )
    except PromotionError as exc:
        _raise(exc)


@router.get("/{project_id}/promotion-packages/{package_id}")
async def api_get_package(
    project_id: str,
    package_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await get_package(db, project_id=project_id, package_id=package_id, user_id=user_id)
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/assess")
async def api_assess_package(
    project_id: str,
    package_id: str,
    body: RevisionBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await assess_package(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            expected_revision=body.expected_revision,
            fill=body.fill,
        )
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/facts")
async def api_confirm_facts(
    project_id: str,
    package_id: str,
    body: ConfirmBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await confirm_facts(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            expected_revision=body.expected_revision,
            goal=body.goal,
            audience=body.audience,
            summary=body.summary,
            facts=[item.model_dump() for item in body.facts],
            adopted_candidate_ids=body.adopted_candidate_ids,
        )
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/generate")
async def api_generate_package(
    project_id: str,
    package_id: str,
    body: GenerateBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await generate_package(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            expected_revision=body.expected_revision,
            products=body.products,
        )
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/revise")
async def api_revise_output(
    project_id: str,
    package_id: str,
    body: ReviseBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await revise_output(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            expected_revision=body.expected_revision,
            output_id=body.output_id,
            expected_version=body.expected_version,
            content=body.content,
            fact_ids=body.fact_ids,
        )
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/reviews")
async def api_review_output(
    project_id: str,
    package_id: str,
    body: ReviewBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await review_output(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            expected_revision=body.expected_revision,
            output_id=body.output_id,
            expected_version=body.expected_version,
            action=body.action,
            comment=body.comment,
        )
    except PromotionError as exc:
        _raise(exc)


@router.post("/{project_id}/promotion-packages/{package_id}/export")
async def api_export_package(
    project_id: str,
    package_id: str,
    body: ExportBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        filename, data = await export_package(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            output_ids=body.output_ids,
        )
    except PromotionError as exc:
        _raise(exc)
    disposition = f"attachment; filename*=UTF-8''{quote(filename)}"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": disposition},
    )


@router.post("/{project_id}/promotion-packages/{package_id}/save-to-project")
async def api_save_package_to_project(
    project_id: str,
    package_id: str,
    body: ExportBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    try:
        return await save_package_to_project(
            db,
            project_id=project_id,
            package_id=package_id,
            user_id=user_id,
            output_ids=body.output_ids,
        )
    except PromotionError as exc:
        _raise(exc)
