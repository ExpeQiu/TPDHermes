import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "@/test-utils/hook-test-utils";
import { cleanupDom, renderComponent } from "@/test-utils/component-test-utils";
import {
  inferAutoCreateDraftFileName,
  normalizeAutoCreateDraftContent,
  shouldAutoCreateDraftFromAssistant,
} from "./co-create-auto-draft";
import CoCreatePage from "./page";

const mocks = vi.hoisted(() => ({
  nav: {
    params: { id: "project-1" as string | undefined },
    searchParams: new URLSearchParams(),
  },
  topbarProps: null as Record<string, unknown> | null,
  workspaceColumnsProps: null as Record<string, unknown> | null,
  apiGet: vi.fn(),
  fetchProjectContext: vi.fn(),
  fetchChatBootstrap: vi.fn(),
  applyFileAction: vi.fn(),
  archiveProjectOutput: vi.fn(),
  fetchProjectFileDetail: vi.fn(),
  projectCoCreateSessionDefaults: vi.fn(),
  useEffectiveUserScopeId: vi.fn(),
  useChatExecution: vi.fn(),
  useChatSessionStore: vi.fn(),
  sessionToPatchPayload: vi.fn(),
  useFileWorkspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => mocks.nav.params,
  useSearchParams: () => ({
    get: (key: string) => mocks.nav.searchParams.get(key),
  }),
}));

vi.mock("@/lib/api", () => ({
  apiGet: mocks.apiGet,
  apiV1: (path: string) => `/api/v1${path}`,
}));

vi.mock("@/lib/chat-context", async () => {
  const actual = (await vi.importActual("@/lib/chat-context")) as typeof import("@/lib/chat-context");
  return {
    ...actual,
    fetchProjectContext: mocks.fetchProjectContext,
    fetchChatBootstrap: mocks.fetchChatBootstrap,
  };
});

vi.mock("@/lib/co-create-api", async () => {
  const actual = (await vi.importActual("@/lib/co-create-api")) as typeof import("@/lib/co-create-api");
  return {
    ...actual,
    applyFileAction: mocks.applyFileAction,
    archiveProjectOutput: mocks.archiveProjectOutput,
    fetchProjectFileDetail: mocks.fetchProjectFileDetail,
  };
});

vi.mock("@/lib/chat-session-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chat-session-utils")>(
    "@/lib/chat-session-utils",
  );
  return {
    ...actual,
    projectCoCreateSessionDefaults: mocks.projectCoCreateSessionDefaults,
    isChatConversationStarted: (session: { messages?: { role: string }[] }) =>
      Boolean(session?.messages?.some((message) => message.role === "user")),
  };
});

vi.mock("@/lib/use-effective-user-scope-id", () => ({
  useEffectiveUserScopeId: mocks.useEffectiveUserScopeId,
}));

vi.mock("@/app/chat/hooks/use-chat-execution", () => ({
  useChatExecution: mocks.useChatExecution,
}));

vi.mock("@/app/chat/hooks/use-chat-session-store", () => ({
  condenseTopicTitle: (value: string) => value,
  isPlaceholderSessionTitle: () => false,
  sessionToPatchPayload: mocks.sessionToPatchPayload,
  useChatSessionStore: mocks.useChatSessionStore,
}));

vi.mock("@/app/projects/[id]/co-create/hooks/use-file-workspace", () => ({
  useFileWorkspace: mocks.useFileWorkspace,
}));

vi.mock("@/app/projects/[id]/co-create/components/CoCreateTopbar", () => ({
  CoCreateTopbar: (props: Record<string, unknown>) => {
    mocks.topbarProps = props;
    return null;
  },
}));

vi.mock("@/app/projects/[id]/co-create/components/CoCreateWorkspaceColumns", () => ({
  CoCreateWorkspaceColumns: (props: Record<string, unknown>) => {
    mocks.workspaceColumnsProps = props;
    return null;
  },
}));

vi.mock("@/app/projects/[id]/co-create/components/FilePreviewPanel", () => ({
  FilePreviewPanel: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/CoCreateComposer", () => ({
  CoCreateComposer: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/CoCreateMessageStream", () => ({
  CoCreateMessageStream: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/FileCreateCard", () => ({
  FileCreateCard: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/FileDiffModal", () => ({
  FileDiffModal: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/FilePatchCard", () => ({
  FilePatchCard: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/FileRecommendationCard", () => ({
  FileRecommendationCard: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/ProjectFilesPanel", async () => {
  const actual = (await vi.importActual(
    "@/app/projects/[id]/co-create/components/ProjectFilesPanel"
  )) as typeof import("@/app/projects/[id]/co-create/components/ProjectFilesPanel");
  return {
    ...actual,
    ProjectFilesPanel: () => null,
  };
});

vi.mock("@/app/projects/[id]/co-create/components/SessionSidebar", () => ({
  SessionSidebar: () => null,
}));

function createSessionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    title: "项目共创",
    messages: [],
    createdAt: Date.now(),
    selectedProjectId: "project-1",
    sessionKind: "project_co_create",
    pinnedFileIds: [] as string[],
    roundFileIds: [] as string[],
    pendingProposalIds: [] as string[],
    archived: false,
    ...overrides,
  };
}

function createWorkspaceState(overrides: Record<string, unknown> = {}) {
  return {
    files: [] as Array<Record<string, unknown>>,
    loading: false,
    openTabKeys: [] as string[],
    activeFileKey: null as string | null,
    previewFileKey: null as string | null,
    tabLabels: {} as Record<string, string>,
    openFileTab: vi.fn(),
    closeFileTab: vi.fn(),
    selectFileTab: vi.fn(),
    setPreviewFileKey: vi.fn(),
    previewDetail: null,
    previewLoading: false,
    versions: [],
    refreshFiles: vi.fn().mockResolvedValue(undefined),
    patchTabContent: vi.fn(),
    reloadFileTab: vi.fn().mockResolvedValue(undefined),
    resetWorkspace: vi.fn(),
    ...overrides,
  };
}

function createStoreState(overrides: Record<string, unknown> = {}) {
  const sessions = (overrides.sessions as Array<Record<string, unknown>> | undefined) ?? [];
  const activeId =
    (overrides.activeId as string | null | undefined) ?? (sessions[0]?.id as string | undefined) ?? null;
  const activeSession =
    (overrides.activeSession as Record<string, unknown> | null | undefined) ??
    (sessions.find((session) => session.id === activeId) as Record<string, unknown> | undefined) ??
    null;
  return {
    sessions,
    activeId,
    activeSession,
    sessionsLoading: false,
    sessionsSyncError: "",
    setSessionsSyncError: vi.fn(),
    sessionsRef: { current: sessions },
    activeIdRef: { current: activeId },
    updateSession: vi.fn(),
    queueSessionPatch: vi.fn(),
    queueMessageSync: vi.fn(),
    flushSessionToServer: vi.fn(),
    createSession: vi.fn(),
    selectSession: vi.fn(),
    deleteSession: vi.fn(),
    ...overrides,
  };
}

describe("CoCreatePage", () => {
  beforeEach(() => {
    cleanupDom();
    mocks.topbarProps = null;
    mocks.workspaceColumnsProps = null;
    mocks.nav.params = { id: "project-1" };
    mocks.nav.searchParams = new URLSearchParams();

    mocks.apiGet.mockReset();
    mocks.fetchProjectContext.mockReset();
    mocks.fetchChatBootstrap.mockReset();
    mocks.applyFileAction.mockReset();
    mocks.archiveProjectOutput.mockReset();
    mocks.fetchProjectFileDetail.mockReset();
    mocks.projectCoCreateSessionDefaults.mockReset();
    mocks.useEffectiveUserScopeId.mockReset();
    mocks.useChatExecution.mockReset();
    mocks.useChatSessionStore.mockReset();
    mocks.sessionToPatchPayload.mockReset();
    mocks.useFileWorkspace.mockReset();

    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/scenarios/") {
        return Promise.resolve([]);
      }
      return Promise.resolve({
        id: "project-1",
        name: "Hermes 集成项目",
        status: "active",
      });
    });
    mocks.fetchProjectContext.mockResolvedValue({
      project_id: "project-1",
      name: "Hermes 集成项目",
      description: null,
      background: null,
      audience: null,
      attachments: [],
      recent_outputs: [],
      kb_stats: {
        collection: "project.project-1.kb",
        attachments_indexed: 0,
        outputs_indexed: 1,
      },
    });
    mocks.fetchChatBootstrap.mockResolvedValue({
      projects: [],
      collections: ["project.project-1.kb"],
      skills: ["skill-a"],
      transport: null,
      warnings: [],
    });
    mocks.projectCoCreateSessionDefaults.mockImplementation((projectId: string) => ({
      id: "new-session",
      title: "新建共创",
      selectedProjectId: projectId,
      sessionKind: "project_co_create",
      messages: [],
      pinnedFileIds: [],
      roundFileIds: [],
    }));
    mocks.useEffectiveUserScopeId.mockReturnValue("user-1");
    mocks.useChatExecution.mockReturnValue({
      sendMessage: vi.fn().mockResolvedValue(undefined),
    });
    mocks.sessionToPatchPayload.mockReturnValue({ patched: true });
    mocks.useFileWorkspace.mockReturnValue(createWorkspaceState());
    mocks.useChatSessionStore.mockReturnValue(createStoreState());
  });

  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("renders fallback branch when project id is missing", () => {
    mocks.nav.params = { id: undefined };

    const { container } = renderComponent(React.createElement(CoCreatePage));

    expect(container.textContent).toContain("缺少项目 ID");
    expect(mocks.fetchProjectContext).not.toHaveBeenCalled();
    expect(mocks.projectCoCreateSessionDefaults).not.toHaveBeenCalled();
  });

  it("renders error state when project is not found", async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === "/scenarios/") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error("Project not found"));
    });
    mocks.fetchProjectContext.mockRejectedValue(new Error("Project not found"));

    const { container } = renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(container.textContent).toContain("无法打开项目共创");
    });

    expect(container.textContent).toContain("返回项目中心");
    expect(container.textContent).toContain("查看 User ID 设置");
    expect(mocks.topbarProps).toBeNull();
  });

  it("creates a new session instead of binding an orphan that already has messages", async () => {
    const orphanSession = createSessionRecord({
      id: "orphan-with-history",
      selectedProjectId: "",
      title: "营销素材",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "请基于当前项目上下文，输出营销素材",
          userPrompt: "营销素材",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "吉利雷神EM-i超级电混技术发布会 领导人发言稿",
        },
      ],
    });
    const storeState = createStoreState({
      sessions: [orphanSession],
      activeId: "orphan-with-history",
      activeSession: orphanSession,
    });
    mocks.useChatSessionStore.mockReturnValue(storeState);

    renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(storeState.createSession).toHaveBeenCalledTimes(1);
    });

    expect(storeState.updateSession).not.toHaveBeenCalled();
    expect(storeState.selectSession).not.toHaveBeenCalledWith("orphan-with-history");
    expect(mocks.projectCoCreateSessionDefaults).toHaveBeenCalledWith("project-1");
  });

  it("aligns to the project empty session when active session belongs to another project", async () => {
    const otherProjectSession = createSessionRecord({
      id: "other-project-session",
      selectedProjectId: "project-other",
      title: "知识问答",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "请基于当前项目上下文，输出可复用的知识问答与摘要",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "（本轮未生成可见正文。Agent 可能仍在检索或仅执行了工具；请稍后重试，或检查 Hermes 上游是否正常。）",
        },
      ],
    });
    const projectEmptySession = createSessionRecord({
      id: "project-empty",
      title: "新共创",
      messages: [],
      createdAt: Date.now(),
    });
    const storeState = createStoreState({
      sessions: [otherProjectSession, projectEmptySession],
      activeId: "other-project-session",
      activeSession: otherProjectSession,
    });
    mocks.useChatSessionStore.mockReturnValue(storeState);

    renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(storeState.selectSession).toHaveBeenCalledWith("project-empty");
    });

    expect(storeState.createSession).not.toHaveBeenCalled();
  });

  it("creates a fresh session instead of binding an empty orphan bootstrap session", async () => {
    const orphanSession = createSessionRecord({
      id: "orphan-empty",
      selectedProjectId: "",
      title: "新共创",
      messages: [],
    });
    const storeState = createStoreState({
      sessions: [orphanSession],
      activeId: "orphan-empty",
      activeSession: orphanSession,
    });
    mocks.useChatSessionStore.mockReturnValue(storeState);

    renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(storeState.createSession).toHaveBeenCalledTimes(1);
    });

    expect(storeState.updateSession).not.toHaveBeenCalled();
    expect(storeState.selectSession).not.toHaveBeenCalledWith("orphan-empty");
    expect(mocks.projectCoCreateSessionDefaults).toHaveBeenCalledWith("project-1");
  });

  it("creates a default co-create session and injects initial output from url params", async () => {
    mocks.nav.searchParams = new URLSearchParams("output_id=out-9");
    const storeState = createStoreState({
      sessions: [],
      activeId: null,
      activeSession: null,
    });
    const workspaceState = createWorkspaceState({
      files: [
        {
          id: "out-1",
          kind: "output",
          title: "方案草稿.md",
          path: "/输出/方案草稿.md",
          file_type: "markdown",
        },
      ],
    });
    mocks.useChatSessionStore.mockReturnValue(storeState);
    mocks.useFileWorkspace.mockReturnValue(workspaceState);

    renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(storeState.createSession).toHaveBeenCalledTimes(1);
    });

    expect(mocks.projectCoCreateSessionDefaults).toHaveBeenCalledWith("project-1");
    expect(storeState.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedProjectId: "project-1",
        sessionKind: "project_co_create",
        roundFileIds: ["output:out-9"],
        pinnedFileIds: [],
      }),
    );

    await waitFor(() => {
      expect(mocks.topbarProps).not.toBeNull();
    });
    expect(mocks.topbarProps?.projectName).toBe("Hermes 集成项目");
    expect(mocks.topbarProps?.outputCount).toBe(1);
  });

  it("reuses an existing project session, selects it, and opens the initial file from the url", async () => {
    mocks.nav.searchParams = new URLSearchParams("output_id=out-3");
    const session = createSessionRecord({
      id: "session-existing",
      roundFileIds: [],
      pinnedFileIds: ["output:out-1"],
    });
    const storeState = createStoreState({
      sessions: [session],
      activeId: "session-existing",
      activeSession: session,
    });
    const workspaceState = createWorkspaceState({
      files: [
        {
          id: "out-1",
          kind: "output",
          title: "方案草稿.md",
          path: "/输出/方案草稿.md",
          file_type: "markdown",
        },
        {
          id: "out-2",
          kind: "output",
          title: "执行稿.md",
          path: "/输出/执行稿.md",
          file_type: "markdown",
        },
      ],
    });
    mocks.useChatSessionStore.mockReturnValue(storeState);
    mocks.useFileWorkspace.mockReturnValue(workspaceState);

    renderComponent(React.createElement(CoCreatePage));

    await waitFor(() => {
      expect(storeState.updateSession).toHaveBeenCalledWith(
        "session-existing",
        expect.any(Function),
      );
    });

    expect(storeState.selectSession).not.toHaveBeenCalled();
    expect(storeState.queueSessionPatch).toHaveBeenCalledWith(
      "session-existing",
      { patched: true },
    );
    expect(workspaceState.openFileTab).toHaveBeenCalledWith("output:out-3");

    await waitFor(() => {
      expect(mocks.topbarProps).not.toBeNull();
      expect(mocks.workspaceColumnsProps).not.toBeNull();
    });
    expect(mocks.topbarProps?.pinnedFileIds).toEqual(["output:out-1"]);
    expect(mocks.workspaceColumnsProps?.sidebarOpen).toBe(true);
  });

  it("normalizes assistant markdown before auto creating a draft", () => {
    const content = `
\`\`\`markdown
# 产品需求文档

这里是正文。
\`\`\`

\`\`\`tphermes_file_actions
{"actions":[{"type":"create","fileName":"忽略.md"}]}
\`\`\`
`;

    expect(normalizeAutoCreateDraftContent(content)).toBe("# 产品需求文档\n\n这里是正文。");
  });

  it("detects create-document intent for auto draft creation", () => {
    expect(
      shouldAutoCreateDraftFromAssistant(
        "请生成一份产品需求文档",
        "# 产品需求文档\n\n## 背景\n需要一份可直接评审的 PRD。",
      ),
    ).toBe(true);

    expect(
      shouldAutoCreateDraftFromAssistant(
        "请解读当前文件",
        "这是一个简短说明。",
      ),
    ).toBe(false);

    expect(
      shouldAutoCreateDraftFromAssistant(
        "请生成一份产品需求文档",
        "# 产品需求文档\n\n## 背景\n需要一份可直接评审的 PRD。",
        true,
      ),
    ).toBe(false);
  });

  it("infers a markdown file name from the generated draft", () => {
    expect(
      inferAutoCreateDraftFileName(
        "请生成一份发布会传播方案",
        "# 2026 发布会传播方案\n\n## 目标\n扩大声量",
      ),
    ).toBe("2026 发布会传播方案.md");

    expect(
      inferAutoCreateDraftFileName(
        "请生成一份发布会传播方案",
        "正文没有标题，但需要自动创建文稿。",
      ),
    ).toBe("发布会传播方案.md");
  });
});
