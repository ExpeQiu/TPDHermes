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
from backend.models.kb_cache import KBCache as _KBCache  # noqa: E402, F401
from backend.models.kb_kg_link import KbKgLink as _KbKgLink  # noqa: E402, F401
from backend.models.kb_ingest_job import KbIngestJob as _KbIngestJob  # noqa: E402, F401
from backend.models.kb_source_file import KbSourceFile as _KbSourceFile  # noqa: E402, F401
from backend.models import kg_entities as _kg_entities  # noqa: E402, F401
from backend.models.usage_event import UsageEvent as _UsageEvent  # noqa: E402, F401
from backend.models.feedback_event import FeedbackEvent as _FeedbackEvent  # noqa: E402, F401
from backend.models.learning_signal import LearningSignal as _LearningSignal  # noqa: E402, F401
from backend.models.learning_report import LearningReport as _LearningReport  # noqa: E402, F401
from backend.models.feedback_prompt import FeedbackPrompt as _FeedbackPrompt  # noqa: E402, F401
from backend.models.experience_entry import ExperienceEntry as _ExperienceEntry  # noqa: E402, F401
from backend.models.chat_session import ChatSessionRecord as _ChatSessionRecord  # noqa: E402, F401
from backend.models.chat_session import ChatMessageRecord as _ChatMessageRecord  # noqa: E402, F401
from backend.models.user_preference import UserPreference as _UserPreference  # noqa: E402, F401
