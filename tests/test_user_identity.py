"""user_identity 推导逻辑单测。"""

import os

from starlette.requests import Request

from backend.services.user_identity import (
    derive_user_id,
    effective_user_id_for_api,
    normalize_user_id,
)


def test_normalize_user_id():
    assert normalize_user_id(None) == "default"
    assert normalize_user_id("") == "default"
    assert normalize_user_id("  u1  ") == "u1"


def test_derive_user_id_with_provided():
    scope = {"type": "http", "headers": []}
    req = Request(scope)
    assert derive_user_id(req, "custom-user") == "custom-user"


def test_derive_user_id_default_literal():
    scope = {"type": "http", "headers": []}
    req = Request(scope)
    assert derive_user_id(req, "default") == "default"


def test_derive_user_id_auto_generated():
    scope = {
        "type": "http",
        "headers": [(b"user-agent", b"test-agent")],
        "client": ("127.0.0.1", 1234),
    }
    req = Request(scope)
    result = derive_user_id(req, None)
    assert result.startswith("auto_")


def test_derive_user_id_with_x_forwarded_for():
    scope = {
        "type": "http",
        "headers": [
            (b"x-forwarded-for", b"203.0.113.7, 10.0.0.1"),
            (b"user-agent", b"ua"),
        ],
    }
    req = Request(scope)
    result = derive_user_id(req, None)
    assert result.startswith("auto_")


def test_effective_user_id_ignores_body_by_default():
    scope = {
        "type": "http",
        "headers": [
            (b"x-user-id", b"from-header"),
        ],
        "client": ("127.0.0.1", 1),
    }
    req = Request(scope)
    os.environ.pop("TPDHERMES_ALLOW_USER_ID_OVERRIDE", None)
    assert effective_user_id_for_api(req, body_user_id="from-body") == "from-header"


def test_effective_user_id_body_override_when_enabled(monkeypatch):
    scope = {
        "type": "http",
        "headers": [
            (b"x-user-id", b"from-header"),
        ],
        "client": ("127.0.0.1", 1),
    }
    req = Request(scope)
    monkeypatch.setenv("TPDHERMES_ALLOW_USER_ID_OVERRIDE", "1")
    assert effective_user_id_for_api(req, body_user_id="from-body") == "from-body"


def test_effective_user_id_header_before_fingerprint():
    scope = {
        "type": "http",
        "headers": [(b"x-user-id", b"h1")],
        "client": ("127.0.0.1", 1),
    }
    req = Request(scope)
    assert effective_user_id_for_api(req) == "h1"
