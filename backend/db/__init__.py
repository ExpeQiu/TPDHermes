import os

from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./tphermes.db")

engine = create_async_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)

async_session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with async_session_maker() as session:
        yield session


# 注册 ORM 元数据（编排相关表）
from backend.models import project as _project  # noqa: E402, F401
from backend.models.template import Template as _Template  # noqa: E402, F401
from backend.models.output_asset import OutputAsset as _OutputAsset  # noqa: E402, F401
from backend.models.orchestration_run import OrchestrationRun as _OrchestrationRun  # noqa: E402, F401
from backend.models.project_config import ProjectConfig as _ProjectConfig  # noqa: E402, F401
from backend.models.scenario_profile import ScenarioProfile as _ScenarioProfile  # noqa: E402, F401
from backend.models.project_scenario import ProjectScenario as _ProjectScenario  # noqa: E402, F401
from backend.models.project_attachment import ProjectAttachment as _ProjectAttachment  # noqa: E402, F401
