import logging
import os

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import StaticPool

logger = logging.getLogger("tpdx.hermes")


class Base(DeclarativeBase):
    pass


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./tphermes.db")

engine = create_async_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)


@event.listens_for(engine.sync_engine, "connect")
def _sqlite_on_connect(dbapi_conn, _connection_record) -> None:
    """每个连接启用 FK，并切到 WAL 提升读写并发。"""
    cursor = dbapi_conn.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=5000")
        # WAL / synchronous 在只读或部分挂载上可能失败，失败不阻断启动
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
        except Exception as exc:  # noqa: BLE001
            logger.warning("sqlite_on_connect: WAL setup skipped: %s", exc)
    finally:
        cursor.close()


async_session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db():
    async with async_session_maker() as session:
        yield session


async def apply_sqlite_runtime_pragmas() -> None:
    """启动时再确认一次关键 PRAGMA（便于日志观测）。"""
    if not str(DATABASE_URL).startswith("sqlite"):
        return
    async with engine.begin() as conn:
        fk = (await conn.execute(text("PRAGMA foreign_keys"))).scalar()
        mode = (await conn.execute(text("PRAGMA journal_mode"))).scalar()
        logger.info("sqlite runtime pragmas foreign_keys=%s journal_mode=%s", fk, mode)


# 注册 ORM 元数据（编排相关表）
from backend.models import project as _project  # noqa: E402, F401
from backend.models.template import Template as _Template  # noqa: E402, F401
from backend.models.output_asset import OutputAsset as _OutputAsset  # noqa: E402, F401
from backend.models.orchestration_run import OrchestrationRun as _OrchestrationRun  # noqa: E402, F401
from backend.models.project_config import ProjectConfig as _ProjectConfig  # noqa: E402, F401
from backend.models.scenario_profile import ScenarioProfile as _ScenarioProfile  # noqa: E402, F401
from backend.models.project_scenario import ProjectScenario as _ProjectScenario  # noqa: E402, F401
from backend.models.project_attachment import ProjectAttachment as _ProjectAttachment  # noqa: E402, F401
from backend.models.kb_cache import KBCache as _KBCache  # noqa: E402, F401
from backend.models.kb_kg_link import KbKgLink as _KbKgLink  # noqa: E402, F401
from backend.models.kb_ingest_job import KbIngestJob as _KbIngestJob  # noqa: E402, F401
from backend.models.kb_source_file import KbSourceFile as _KbSourceFile  # noqa: E402, F401
from backend.models.knowledge_policy import KnowledgePolicy as _KnowledgePolicy  # noqa: E402, F401
from backend.models.knowledge_policy_version import KnowledgePolicyVersion as _KnowledgePolicyVersion  # noqa: E402, F401
from backend.models import kg_entities as _kg_entities  # noqa: E402, F401
from backend.models.usage_event import UsageEvent as _UsageEvent  # noqa: E402, F401
from backend.models.feedback_event import FeedbackEvent as _FeedbackEvent  # noqa: E402, F401
from backend.models.learning_signal import LearningSignal as _LearningSignal  # noqa: E402, F401
from backend.models.learning_report import LearningReport as _LearningReport  # noqa: E402, F401
from backend.models.feedback_prompt import FeedbackPrompt as _FeedbackPrompt  # noqa: E402, F401
from backend.models.experience_entry import ExperienceEntry as _ExperienceEntry  # noqa: E402, F401
from backend.models.chat_session import ChatSessionRecord as _ChatSessionRecord  # noqa: E402, F401
from backend.models.chat_session import ChatMessageRecord as _ChatMessageRecord  # noqa: E402, F401
from backend.models.project_file_domain import ProjectFile as _ProjectFile  # noqa: E402, F401
from backend.models.project_file_domain import ProjectFileVersion as _ProjectFileVersion  # noqa: E402, F401
from backend.models.project_file_domain import ProjectSessionFileRef as _ProjectSessionFileRef  # noqa: E402, F401
from backend.models.project_file_domain import ProjectFileActionLog as _ProjectFileActionLog  # noqa: E402, F401
from backend.models.user_preference import UserPreference as _UserPreference  # noqa: E402, F401
from backend.models.skill import Skill as _Skill  # noqa: E402, F401
from backend.models.project_member import ProjectMember as _ProjectMember  # noqa: E402, F401
