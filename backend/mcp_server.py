"""
TPDHermes MCP Server

FastMCP Server exposing TPDHermes core capabilities via stdio/HTTP MCP transport.
Hermes-agent connects to this server to access Knowledge Base, Workshop, Project,
and mounted external MCP capabilities such as Tavily Remote MCP.
"""

from fastmcp import FastMCP

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
        "Searches the specified ChromaDB collection by semantic similarity."
    ),
)
async def kb_query(
    query: str,
    collection_name: str,
    limit: int = 10,
    project_id: str | None = None,
) -> dict:
    """Query the knowledge base."""
    from backend.tools.kb_tools import kb_query as _kb_query
    return await _kb_query(query, collection_name, limit, project_id)


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
) -> dict:
    """Get a specific KB entry."""
    from backend.tools.kb_tools import kb_get_entry as _kb_get
    return await _kb_get(collection_name, entry_id, project_id)


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
def workshop_list_skills() -> dict:
    """List all available Skills."""
    from backend.tools.workshop_tools import workshop_list_skills as _list
    return _list()


@mcp.tool(
    title="Workshop Get Skill Info",
    description="Get detailed information about a specific Skill.",
)
def workshop_get_skill_info(skill_name: str) -> dict:
    """Get skill details."""
    from backend.tools.workshop_tools import workshop_get_skill_info as _info
    return _info(skill_name)


@mcp.tool(
    title="Workshop Generate",
    description="Execute a Skill's generate() method with the given context and return the result.",
)
async def workshop_generate(skill_name: str, context: dict) -> dict:
    """Execute a Skill."""
    from backend.tools.workshop_tools import workshop_generate as _gen
    return await _gen(skill_name, context)


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
    context: dict | None = None,
) -> dict:
    """Execute a Skill with KB-augmented context."""
    from backend.tools.workshop_tools import workshop_generate_from_kb as _gen_from_kb
    return await _gen_from_kb(
        skill_name=skill_name,
        query=query,
        collection_name=collection_name,
        limit=limit,
        project_id=project_id,
        context=context,
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


# Optional external MCP mounts
mount_tavily_remote_mcp(mcp)


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Default transport is stdio — hermes-agent connects via stdin/stdout
    mcp.run()
