"""
TPDHermes MCP Server

FastMCP Server exposing TPDHermes core capabilities via stdio/HTTP MCP transport.
Hermes-agent connects to this server to access Knowledge Base, Workshop, Project,
and mounted external MCP capabilities such as Tavily Remote MCP.
"""

from typing import Any

from fastmcp import FastMCP

from backend.mcp_tool_utils import coerce_tool_context
from backend.mcp_tavily import mount_tavily_remote_mcp

# Initialize FastMCP server
mcp = FastMCP(
    name="TPDHermes",
    instructions=(
        "TPDHermes MCP Server — provides access to:\n"
        "- Knowledge Base: query, list collections, get entries, add harvest entries (with user confirmation)\n"
        "- Workshop: list skills, execute skill generation\n"
        "- Projects: list, create, get project details\n"
    ),
)

# ─── Import tools lazily to avoid import-time side effects ───────────────────

# ─── Knowledge Base Tools ─────────────────────────────────────────────────────

@mcp.tool(
    title="KB Query",
    description=(
        "Query the knowledge base for documents matching a text query. "
        "Searches the specified ChromaDB collection by semantic similarity. "
        "When invoked from TPDHermes chat/workshop agent, tphermes_run_id is required "
        "(from orchestration execution.run_id) for citation tracking."
    ),
)
async def kb_query(
    query: str,
    collection_name: str,
    limit: int = 10,
    project_id: str | None = None,
    tphermes_run_id: str | None = None,
) -> dict:
    """Query the knowledge base."""
    from backend.tools.kb_tools import kb_query as _kb_query
    return await _kb_query(query, collection_name, limit, project_id, tphermes_run_id)


@mcp.tool(
    title="KB List Collections",
    description="List all available knowledge base collections.",
)
async def kb_list_collections(project_id: str | None = None) -> dict:
    """List all KB collections."""
    from backend.tools.kb_tools import kb_list_collections as _kb_list
    return await _kb_list(project_id)


@mcp.tool(
    title="KB Get Entry",
    description="Retrieve a specific knowledge base entry by its ID.",
)
async def kb_get_entry(
    collection_name: str,
    entry_id: str,
    project_id: str,
    tphermes_run_id: str | None = None,
) -> dict:
    """Get a specific KB entry."""
    from backend.tools.kb_tools import kb_get_entry as _kb_get
    return await _kb_get(collection_name, entry_id, project_id, tphermes_run_id)


@mcp.tool(
    title="KB Add Entry",
    description=(
        "Write a user-confirmed knowledge excerpt to the KB (conversation harvest). "
        "Requires explicit user confirmation in the dialogue before calling. "
        "Default published=false (draft); use KB publish workflow to approve. "
        "Never call without the user agreeing to save."
    ),
)
async def kb_add_entry(
    collection_name: str,
    project_id: str,
    title: str,
    content: str,
    summary: str = "",
    tags: list[str] | None = None,
    domain: str = "internal_methodology",
    source: str = "hermes_chat",
    published: bool = False,
    metadata: dict | None = None,
    scenario_id: str | None = None,
) -> dict:
    """Add an excerpt as a KB document."""
    from backend.tools.kb_tools import kb_add_entry as _kb_add
    return await _kb_add(
        collection_name=collection_name,
        project_id=project_id,
        title=title,
        content=content,
        summary=summary,
        tags=tags,
        domain=domain,
        source=source,
        published=published,
        metadata=metadata,
        scenario_id=scenario_id,
    )


# ─── Workshop / Skill Tools ───────────────────────────────────────────────────

@mcp.tool(
    title="Workshop List Skills",
    description="List all Skills available in the workshop (skills/ directory).",
)
async def workshop_list_skills(user_id: str | None = None) -> dict:
    """List all available Skills."""
    from backend.tools.workshop_tools import workshop_list_skills as _list
    return await _list(user_id=user_id)


@mcp.tool(
    title="Workshop Get Skill Info",
    description="Get detailed information about a specific Skill.",
)
async def workshop_get_skill_info(skill_name: str, user_id: str | None = None) -> dict:
    """Get skill details."""
    from backend.tools.workshop_tools import workshop_get_skill_info as _info
    return await _info(skill_name, user_id=user_id)


@mcp.tool(
    title="Workshop Generate",
    description=(
        "Execute a Skill's generate() method with the given context and return the result. "
        "When invoked from TPDHermes workshop agent flow, tphermes_run_id is required."
    ),
)
async def workshop_generate(
    skill_name: str,
    context: dict[str, Any] | str | None = None,
    tphermes_run_id: str | None = None,
) -> dict:
    """Execute a Skill."""
    from backend.tools.workshop_tools import workshop_generate as _gen

    ctx = coerce_tool_context(context)
    if tphermes_run_id:
        ctx["tphermes_run_id"] = tphermes_run_id
    return await _gen(skill_name, ctx)


@mcp.tool(
    title="Workshop Generate From KB",
    description=(
        "Query the knowledge base first, auto-build a Skill context, "
        "then execute the Skill and return the KB result, mapped context, and output."
    ),
)
async def workshop_generate_from_kb(
    skill_name: str,
    query: str,
    collection_name: str,
    limit: int = 3,
    project_id: str | None = None,
    context: dict[str, Any] | str | None = None,
    tphermes_run_id: str | None = None,
) -> dict:
    """Execute a Skill with KB-augmented context."""
    from backend.tools.workshop_tools import workshop_generate_from_kb as _gen_from_kb

    ctx = coerce_tool_context(context)
    if tphermes_run_id:
        ctx["tphermes_run_id"] = tphermes_run_id
    return await _gen_from_kb(
        skill_name=skill_name,
        query=query,
        collection_name=collection_name,
        limit=limit,
        project_id=project_id,
        context=ctx,
    )


# ─── Project Tools ─────────────────────────────────────────────────────────────

@mcp.tool(
    title="Project List",
    description="List all projects, optionally filtered by status.",
)
async def project_list(status: str | None = None, user_id: str = "") -> dict:
    """List all projects."""
    from backend.tools.project_tools import project_list as _list
    return await _list(status, user_id=user_id)


@mcp.tool(
    title="Project Create",
    description="Create a new project with name, description, and background.",
)
async def project_create(
    name: str,
    description: str | None = None,
    background: str | None = None,
    user_id: str = "default",
) -> dict:
    """Create a new project."""
    from backend.tools.project_tools import project_create as _create
    return await _create(name, description, background, user_id=user_id)


@mcp.tool(
    title="Project Get",
    description="Get a project by its ID.",
)
async def project_get(id: str, user_id: str = "") -> dict:
    """Get a project by ID."""
    from backend.tools.project_tools import project_get as _get
    return await _get(id, user_id=user_id)


# Optional external MCP mounts — 本地 Tavily 工具优先（带来源捕获），无 API Key 时回退远程代理
import os

if os.getenv("TAVILY_API_KEY", "").strip():

    @mcp.tool(
        title="Tavily Search",
        description=(
            "Search the web via Tavily. When invoked from TPDHermes chat/workshop agent, "
            "tphermes_run_id is required (from orchestration execution.run_id) for citation tracking. "
            "Cite web facts with [^N] using ref from results."
        ),
    )
    async def tavily_search(
        query: str,
        max_results: int = 5,
        tphermes_run_id: str | None = None,
        project_id: str | None = None,
    ) -> dict:
        from backend.tools.tavily_tools import tavily_search as _search

        return await _search(
            query,
            max_results=max_results,
            tphermes_run_id=tphermes_run_id,
            project_id=project_id,
        )

    @mcp.tool(
        title="Tavily Extract",
        description=(
            "Extract web page content via Tavily. Pass tphermes_run_id when called from "
            "TPDHermes agent for citation tracking; cite with [^N] from results."
        ),
    )
    async def tavily_extract(
        urls: list[str],
        tphermes_run_id: str | None = None,
        project_id: str | None = None,
    ) -> dict:
        from backend.tools.tavily_tools import tavily_extract as _extract

        return await _extract(
            urls,
            tphermes_run_id=tphermes_run_id,
            project_id=project_id,
        )
else:
    mount_tavily_remote_mcp(mcp)


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Default transport is stdio — hermes-agent connects via stdin/stdout
    mcp.run()
