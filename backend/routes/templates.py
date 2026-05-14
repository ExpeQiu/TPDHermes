"""输出模板资产 CRUD。"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.models.template import Template

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/templates", tags=["templates"])


class TemplateCreate(BaseModel):
    name: str
    content: str
    category: str | None = None
    structure_json: dict[str, Any] | None = None
    format: str = "markdown"
    version: str = "1.0.0"


class TemplateUpdate(BaseModel):
    name: str | None = None
    content: str | None = None
    category: str | None = None
    structure_json: dict[str, Any] | None = None
    format: str | None = None
    version: str | None = None
    status: str | None = None


class TemplateResponse(BaseModel):
    id: str
    name: str
    content: str
    category: str | None
    structure_json: dict[str, Any] | None
    format: str | None
    validation_rules: dict[str, Any] | None
    version: str
    status: str | None
    created_at: str | None
    updated_at: str | None


def _loads_rules(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else None
    except json.JSONDecodeError:
        return None


def _row_to_response(t: Template) -> TemplateResponse:
    sj = None
    if t.schema_json:
        try:
            v = json.loads(t.schema_json)
            sj = v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            sj = None
    return TemplateResponse(
        id=t.id,
        name=t.name,
        content=t.content or "",
        category=t.category,
        structure_json=sj,
        format=t.format,
        validation_rules=_loads_rules(t.validation_rules),
        version=t.version,
        status=getattr(t, "status", None),
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


@router.post("/", response_model=TemplateResponse)
async def create_template(body: TemplateCreate, db: AsyncSession = Depends(get_db)):
    now = datetime.now().isoformat()
    row = Template(
        id=str(uuid.uuid4()),
        name=body.name.strip(),
        content=body.content,
        category=body.category,
        schema_json=json.dumps(body.structure_json, ensure_ascii=False) if body.structure_json else None,
        format=body.format,
        version=body.version,
        status="active",
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("template created id=%s", row.id)
    return _row_to_response(row)


@router.get("/", response_model=list[TemplateResponse])
async def list_templates(db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Template).order_by(Template.updated_at.desc()))
    return [_row_to_response(t) for t in res.scalars().all()]


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(template_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(Template, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="模板不存在")
    return _row_to_response(row)


@router.put("/{template_id}", response_model=TemplateResponse)
async def update_template(
    template_id: str,
    body: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(Template, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="模板不存在")
    data = body.model_dump(exclude_unset=True)
    if "structure_json" in data:
        sj = data.pop("structure_json")
        row.schema_json = json.dumps(sj, ensure_ascii=False) if sj else None
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    return _row_to_response(row)
