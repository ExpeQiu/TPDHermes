from backend.mcp_tavily import _build_remote_url, get_tavily_remote_mcp_url


def test_build_remote_url_appends_api_key_when_missing():
    url = _build_remote_url("https://mcp.tavily.com/mcp/", "tvly-demo")
    assert url == "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-demo"


def test_build_remote_url_preserves_existing_query_and_key():
    url = _build_remote_url(
        "https://mcp.tavily.com/mcp/?foo=bar&tavilyApiKey=already-set",
        "tvly-demo",
    )
    assert url == "https://mcp.tavily.com/mcp/?foo=bar&tavilyApiKey=already-set"


def test_get_tavily_remote_mcp_url_requires_api_key(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("TAVILY_REMOTE_MCP_URL", "https://mcp.tavily.com/mcp/")
    assert get_tavily_remote_mcp_url() == ""


def test_get_tavily_remote_mcp_url_uses_env(monkeypatch):
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-demo")
    monkeypatch.setenv("TAVILY_REMOTE_MCP_URL", "https://mcp.tavily.com/mcp/")
    assert get_tavily_remote_mcp_url() == "https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-demo"
