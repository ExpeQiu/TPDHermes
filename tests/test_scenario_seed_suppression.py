"""内置场景删除后 migration 不再重新 seed。"""

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.data.builtin_scenarios import BUILTIN_SCENARIOS
from backend.db import engine
from backend.db.sqlite_migrate import run_sqlite_migrations

HDR_ADMIN = {"X-User-ID": "default"}


def _pick_builtin_id(present_ids: set[str]) -> str:
    for row in BUILTIN_SCENARIOS:
        sid = str(row["id"])
        if sid in present_ids and sid not in ("general", "refine"):
            return sid
    for row in BUILTIN_SCENARIOS:
        sid = str(row["id"])
        if sid in present_ids:
            return sid
    raise AssertionError(f"no builtin scenario present in {present_ids}")


async def _rerun_sqlite_migrations() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(run_sqlite_migrations)


@pytest.mark.asyncio
async def test_builtin_scenario_delete_survives_reseed():
    with TestClient(app) as client:
        before = client.get("/api/v1/scenarios/", headers=HDR_ADMIN)
        assert before.status_code == 200, before.text
        present = {row["id"] for row in before.json()}
        target = _pick_builtin_id(present)

        deleted = client.delete(f"/api/v1/scenarios/{target}", headers=HDR_ADMIN)
        assert deleted.status_code == 200, deleted.text

        after_delete = client.get("/api/v1/scenarios/", headers=HDR_ADMIN)
        assert after_delete.status_code == 200, after_delete.text
        assert target not in {row["id"] for row in after_delete.json()}

    await _rerun_sqlite_migrations()

    with TestClient(app) as client:
        after_reseed = client.get("/api/v1/scenarios/", headers=HDR_ADMIN)
        assert after_reseed.status_code == 200, after_reseed.text
        assert target not in {row["id"] for row in after_reseed.json()}

    # 恢复本地/共享库：清抑制并重新 seed，避免污染后续开发数据
    async with engine.begin() as conn:
        def _restore(c):
            from sqlalchemy import text

            c.execute(
                text("DELETE FROM scenario_seed_suppressions WHERE scenario_id = :sid"),
                {"sid": target},
            )

        await conn.run_sync(_restore)
    await _rerun_sqlite_migrations()


@pytest.mark.asyncio
async def test_custom_scenario_delete_not_reseeded():
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/scenarios/",
            headers=HDR_ADMIN,
            json={
                "code": f"tmp-{__name__}",
                "name": "临时测试场景",
                "description": "delete reseed test",
            },
        )
        assert created.status_code == 200, created.text
        sid = created.json()["id"]

        deleted = client.delete(f"/api/v1/scenarios/{sid}", headers=HDR_ADMIN)
        assert deleted.status_code == 200, deleted.text

    await _rerun_sqlite_migrations()

    with TestClient(app) as client:
        listing = client.get("/api/v1/scenarios/", headers=HDR_ADMIN)
        assert listing.status_code == 200, listing.text
        assert sid not in {row["id"] for row in listing.json()}
