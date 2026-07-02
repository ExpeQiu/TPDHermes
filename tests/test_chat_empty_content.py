"""空正文 run 状态解析回归测试。"""
from backend.routes.tasks import _resolve_run_status_and_error


def test_empty_content_marks_failed():
    status, err = _resolve_run_status_and_error(
        "",
        must_follow_template=False,
        validation_ok=True,
    )
    assert status == "failed"
    assert err


def test_whitespace_only_content_marks_failed():
    status, err = _resolve_run_status_and_error(
        "   \n  ",
        must_follow_template=False,
        validation_ok=True,
    )
    assert status == "failed"
    assert err


def test_valid_content_stays_completed():
    status, err = _resolve_run_status_and_error(
        "hello",
        must_follow_template=False,
        validation_ok=True,
    )
    assert status == "completed"
    assert err is None


def test_template_validation_failure_is_draft():
    status, err = _resolve_run_status_and_error(
        "hello",
        must_follow_template=True,
        validation_ok=False,
    )
    assert status == "draft"
    assert err is None
