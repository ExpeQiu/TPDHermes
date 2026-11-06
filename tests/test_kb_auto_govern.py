from backend.services.kb_auto_govern import govern_reasons, placement_mode, plan_target
from backend.services.kb_govern_advisor import mock_decisions, parse_govern_decisions
from datetime import datetime

from backend.services.kb_govern_settings import defaults_from_env, normalize_schedule, schedule_is_due


def test_missing_domain_and_folder_need_govern():
    reasons = govern_reasons("_uncategorized", "", {"structured_tech"})
    assert "missing_domain" in reasons
    assert "missing_folder" in reasons


def test_plan_moves_uncategorized_into_policy_domain():
    target = plan_target("_uncategorized", "", ["structured_tech"], "")
    assert target == ("structured_tech", "02-知识库")


def test_plan_keeps_complete_allowed_node():
    assert plan_target("structured_tech", "02-知识库/导入", ["structured_tech"], "") is None


def test_plan_rejects_domain_outside_policy():
    target = plan_target("public_intel", "01-汽车信息库", ["structured_tech"], "")
    assert target == ("structured_tech", "02-知识库")


def test_single_allowed_domain_stays_on_rule_path():
    assert placement_mode("_uncategorized", "", ["structured_tech"]) == "rule"


def test_multiple_allowed_domains_need_agent_when_domain_missing():
    assert placement_mode("_uncategorized", "", ["structured_tech", "public_intel"]) == "agent"


def test_known_domain_with_missing_folder_stays_on_rule_path():
    assert placement_mode("structured_tech", "", ["structured_tech", "public_intel"]) == "rule"


def test_parse_keeps_only_allowed_domain_and_known_doc():
    text = """```json
{"decisions":[
  {"doc_id":"a","domain":"public_intel","folder":"01-汽车信息库/周报"},
  {"doc_id":"b","domain":"other","folder":"x"},
  {"doc_id":"c","domain":"public_intel","folder":""}
]}
```"""
    parsed = parse_govern_decisions(
        text,
        allowed={"public_intel", "structured_tech"},
        pending_ids={"a", "b"},
    )
    assert parsed == {"a": ("public_intel", "01-汽车信息库/周报")}


def test_schedule_normalizes_cadence_and_batch():
    cleaned = normalize_schedule(
        enabled=True,
        cadence="yearly",
        run_time="9:5",
        weekday=8,
        month_day=40,
        agent_batch=0,
        policy_ids=["a", "a", ""],
    )
    assert cleaned["cadence"] == "daily"
    assert cleaned["run_time"] == "09:05"
    assert cleaned["weekday"] == 6
    assert cleaned["month_day"] == 28
    assert cleaned["agent_batch"] == 1
    assert cleaned["policy_ids"] == ["a"]


def test_schedule_defaults_read_env_once(monkeypatch):
    monkeypatch.setenv("KB_GOVERN_SCHEDULER_ENABLED", "true")
    monkeypatch.setenv("KB_GOVERN_AGENT_BATCH", "8")
    seeded = defaults_from_env()
    assert seeded["enabled"] is True
    assert seeded["cadence"] == "daily"
    assert seeded["agent_batch"] == 8


def test_daily_schedule_is_due_only_after_the_clock_and_once():
    morning = datetime(2026, 11, 6, 1, 0)
    evening = datetime(2026, 11, 6, 3, 0)
    settings = {
        "enabled": True,
        "cadence": "daily",
        "run_time": "02:00",
        "weekday": 0,
        "month_day": 1,
        "last_run_at": "",
    }
    assert schedule_is_due(settings, morning) is False
    assert schedule_is_due(settings, evening) is True
    settings["last_run_at"] = "2026-11-06T02:05:00"
    assert schedule_is_due(settings, evening) is False


def test_weekly_schedule_matches_weekday_only():
    # 2026-11-06 is Friday
    friday = datetime(2026, 11, 6, 9, 30)
    settings = {
        "enabled": True,
        "cadence": "weekly",
        "run_time": "09:00",
        "weekday": 0,
        "month_day": 1,
        "last_run_at": "",
    }
    assert schedule_is_due(settings, friday) is False
    settings["weekday"] = 4
    assert schedule_is_due(settings, friday) is True


def test_mock_advisor_uses_first_eligible_domain():
    choices = mock_decisions(
        [{"doc_id": "doc-1"}],
        ["market_research", "public_intel"],
    )
    assert choices["doc-1"][0] == "market_research"
    assert choices["doc-1"][1]
