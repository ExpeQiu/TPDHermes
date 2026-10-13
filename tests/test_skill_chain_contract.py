"""Skills 链路合同：权限、输入校验、执行类型与失败包装。"""

import json

import pytest

from datetime import datetime, timedelta, timezone

from backend.services.execution_grant import execution_grant_matches, issue_execution_grant
from backend.services.skill_loader import Skill, SkillLoader, unwrap_skill_call_result
from backend.services.workshop_guard import WorkshopGuardError, assert_skill_contract
from backend.services.workshop_llm_generator import (
    _build_llm_prompt,
    execute_workshop_skill_generate,
    generate_workshop_deliverable,
    resolve_execution_type,
    should_generate_llm_deliverable,
)
from backend.services.workshop_execution import skill_calls_from_capture
from backend.services.workshop_task_runner import _parse_workshop_context, sse_content_replace


def _policy(**kwargs) -> str:
    base = {
        "mode": "allowed_list",
        "allowed": ["skill_a"],
        "forbidden": [],
        "preferred": [],
        "allow_agent_free_choice": False,
    }
    base.update(kwargs)
    return json.dumps(base, ensure_ascii=False)


class _CountingSkill(Skill):
    def __init__(self):
        self.generate_calls = 0
        self.accept_input = True

    @property
    def name(self) -> str:
        return "counting_skill"

    def validate_input(self, input_data):
        return self.accept_input

    def generate(self, context):
        self.generate_calls += 1
        return {"success": False, "content": None, "error": "inner_failed"}


class _PythonTemplateSkill(Skill):
    template_content = "# 模板不应接管"
    skill_meta = {"execution": {"type": "python"}}

    @property
    def name(self) -> str:
        return "python_with_template"

    def validate_input(self, input_data):
        return True

    def generate(self, context):
        return {"content": "PYTHON_BODY"}


class _LegacyTemplateSkill(Skill):
    template_content = "# 模版"

    @property
    def name(self) -> str:
        return "legacy_template"

    def validate_input(self, input_data):
        return True

    def generate(self, context):
        return {"content": "SHOULD_NOT_RUN"}


def test_contract_rejects_forbidden_even_if_visible_name_allowed():
    with pytest.raises(WorkshopGuardError, match="禁止"):
        assert_skill_contract(
            skill_name="skill_b",
            status="running",
            skills_policy_json=_policy(allowed=["skill_a"], forbidden=["skill_b"]),
        )


def test_contract_forbidden_wins_over_allowed():
    with pytest.raises(WorkshopGuardError, match="禁止"):
        assert_skill_contract(
            skill_name="skill_a",
            status="running",
            skills_policy_json=_policy(allowed=["skill_a"], forbidden=["skill_a"]),
        )


def test_empty_allowed_list_rejects_any_skill():
    with pytest.raises(WorkshopGuardError, match="允许名单为空"):
        assert_skill_contract(
            skill_name="skill_a",
            status="running",
            skills_policy_json=_policy(allowed=[]),
        )


def test_terminal_run_rejects_before_execution():
    with pytest.raises(WorkshopGuardError, match="运行已结束"):
        assert_skill_contract(
            skill_name="skill_a",
            status="completed",
            skills_policy_json=_policy(),
        )


def test_missing_policy_snapshot_does_not_invent_a_contract():
    assert_skill_contract(skill_name="skill_b", status="running", skills_policy_json=None)


def test_unwrap_keeps_inner_failure():
    wrapped = unwrap_skill_call_result(
        "speech_skill",
        {"success": False, "content": None, "error": "boom"},
    )
    assert wrapped["success"] is False
    assert wrapped["error"] == "boom"


@pytest.mark.asyncio
async def test_validate_input_false_does_not_call_generate():
    skill = _CountingSkill()
    skill.accept_input = False
    result = await execute_workshop_skill_generate(skill, {"user_message": "hi"})
    assert skill.generate_calls == 0
    assert result["success"] is False
    assert result["status"] == "failed"


@pytest.mark.asyncio
async def test_inner_generate_failure_stays_failed():
    skill = _CountingSkill()
    result = await execute_workshop_skill_generate(skill, {"user_message": "hi"})
    assert skill.generate_calls == 1
    assert result["success"] is False
    assert result["status"] == "failed"
    assert result["error"] == "inner_failed"


def test_python_execution_type_ignores_template():
    skill = _PythonTemplateSkill()
    execution_type, source = resolve_execution_type(skill)
    assert execution_type == "python"
    assert source == "declared"
    assert should_generate_llm_deliverable(skill) is False


def test_legacy_template_still_infers_llm_until_declared():
    skill = _LegacyTemplateSkill()
    execution_type, source = resolve_execution_type(skill)
    assert execution_type == "llm_template"
    assert source == "legacy_inferred"


@pytest.mark.asyncio
async def test_python_skill_with_template_runs_python():
    result = await execute_workshop_skill_generate(_PythonTemplateSkill(), {"title": "t"})
    assert result["content"] == "PYTHON_BODY"
    assert result["execution_type"] == "python"
    assert result["execution_source"] == "declared"


def test_prompt_keeps_user_message_and_source_material():
    skill = _LegacyTemplateSkill()
    _system, user, truncation = _build_llm_prompt(
        skill,
        {
            "user_message": "MARK_USER_REQ",
            "task_input": {"source_material": "MARK_SOURCE_BODY", "title": "标题"},
        },
    )
    assert "MARK_USER_REQ" in user
    assert "MARK_SOURCE_BODY" in user
    assert truncation == []


def test_prompt_marks_truncated_source():
    skill = _LegacyTemplateSkill()
    _system, user, truncation = _build_llm_prompt(
        skill,
        {"user_message": "短要求", "source_material": "源" * 5000},
    )
    assert "truncated original_chars=5000" in user
    assert truncation == ["source_material"]


def test_json_context_does_not_drop_raw_user_message():
    raw = '{"title":"只有标题"}'
    context = _parse_workshop_context(raw)
    assert context["title"] == "只有标题"
    assert context["user_message"] == raw


@pytest.mark.asyncio
async def test_auth_failure_does_not_compose_generic_draft(monkeypatch):
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://127.0.0.1:9/v1/chat/completions")

    async def _unauthorized(system, user):
        raise RuntimeError("llm_http_401: unauthorized")

    monkeypatch.setattr(
        "backend.services.workshop_llm_generator._call_llm",
        _unauthorized,
    )
    result = await generate_workshop_deliverable(
        _LegacyTemplateSkill(),
        {"tech_name": "不应出现在失败结果"},
    )
    assert result["success"] is False
    assert result["status"] == "failed"
    assert result["content"] is None
    assert "llm_http_401" in result["error"]


def test_content_replace_event_does_not_append_delta():
    event = sse_content_replace(
        "最终正文",
        delivery={"phase": "content_replace", "status": "degraded", "fallback_reason": "agent_tool_miss"},
    )
    assert "content_replace" in event
    assert "最终正文" in event
    assert "choices" not in event
    assert "degraded" in event


def test_skill_calls_distinguish_reject_and_degraded_delivery():
    calls = skill_calls_from_capture(
        {
            "artifacts": [
                {
                    "skill": "skill_b",
                    "raw": {"success": False, "status": "rejected", "skill": "skill_b", "error": "forbidden"},
                },
                {
                    "skill": "skill_a",
                    "raw": {
                        "success": True,
                        "status": "degraded",
                        "skill": "skill_a",
                        "content": {
                            "skill_version": "1.2.0",
                            "execution_type": "llm_template",
                            "status": "degraded",
                            "fallback_reason": "chat_upstream_not_configured",
                            "package_fingerprint": "abc",
                        },
                    },
                },
            ]
        }
    )
    assert calls[0]["call_kind"] == "attempt_rejected"
    assert calls[1]["call_kind"] == "delivered_degraded"
    assert calls[1]["version"] == "1.2.0"
    assert calls[1]["package_fingerprint"] == "abc"


def test_loader_cache_reloads_when_package_changes(tmp_path):
    skill_dir = tmp_path / "demo_skill"
    skill_dir.mkdir()
    init = skill_dir / "__init__.py"
    init.write_text(
        "from backend.services.skill_loader import Skill\n"
        "class DemoSkill(Skill):\n"
        "    @property\n"
        "    def name(self):\n"
        "        return 'demo_skill'\n"
        "    def generate(self, context):\n"
        "        return {'content': 'ONE'}\n",
        encoding="utf-8",
    )
    (skill_dir / "skill.json").write_text('{"name":"demo_skill","version":"1.0.0"}\n', encoding="utf-8")
    loader = SkillLoader(str(tmp_path))
    first = loader.load("demo_skill")
    assert first.generate({})["content"] == "ONE"
    init.write_text(
        "from backend.services.skill_loader import Skill\n"
        "class DemoSkill(Skill):\n"
        "    @property\n"
        "    def name(self):\n"
        "        return 'demo_skill'\n"
        "    def generate(self, context):\n"
        "        return {'content': 'TWO'}\n",
        encoding="utf-8",
    )
    second = loader.load("demo_skill")
    assert second.generate({})["content"] == "TWO"
    assert second.loaded_version == "1.0.0"
    assert second.package_fingerprint != first.package_fingerprint


def test_execution_grant_rejects_missing_wrong_and_expired_tokens():
    token, digest, expires = issue_execution_grant()
    assert execution_grant_matches(digest, expires, token) is None
    assert execution_grant_matches(digest, expires, "") == "缺少执行凭证"
    assert execution_grant_matches(digest, expires, "not-the-token") == "执行凭证无效"
    assert execution_grant_matches("", expires, token) == "运行未签发执行凭证"
    past = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    assert execution_grant_matches(digest, past, token) == "执行凭证已过期"
