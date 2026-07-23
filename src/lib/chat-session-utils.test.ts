import { describe, expect, it } from "vitest";

import type { ChatSession } from "@/app/chat/chat-types";
import {
  condenseTopicTitle,
  isCoCreateSessionForProject,
  isProjectCoCreateSession,
  listAllSurplusEmptyCoCreateSessionIds,
  listSurplusEmptyCoCreateSessionIds,
  pickBootstrapHydrateSessionId,
  pickProjectCoCreateEntrySession,
  sessionHasPersistedMessages,
  titleFromSession,
  userMessageTextForTitle,
} from "@/lib/chat-session-utils";
import { inferSessionKind } from "@/lib/chat-sessions-api";

describe("chat-session-utils titles", () => {
  it("优先使用 userPrompt 作为标题来源", () => {
    expect(
      userMessageTextForTitle({
        content: "请基于当前项目上下文，输出营销素材",
        userPrompt: "2026年吉利CES发布哪些新技术",
      }),
    ).toBe("2026年吉利CES发布哪些新技术");
  });

  it("condenseTopicTitle 剥离共创模板前缀", () => {
    expect(condenseTopicTitle("请基于当前项目上下文，输出营销素材")).toBe("输出营销素材");
    expect(condenseTopicTitle("2026年吉利CES发布哪些新技术？")).toBe(
      "2026年吉利CES发布哪些新技…",
    );
  });

  it("titleFromSession 与 /chat 侧栏一致", () => {
    const session = {
      id: "s1",
      title: "请基于当前项目上下文，输出营销素材",
      messages: [
        {
          id: "m1",
          role: "user" as const,
          content: "请基于当前项目上下文，输出营销素材",
          userPrompt: "营销素材",
        },
      ],
      createdAt: 0,
      selectedProjectId: "p1",
      selectedCollection: "",
      includeProjectContext: true,
      includeKnowledgeContext: false,
      includeSkillsContext: false,
    } satisfies ChatSession;

    expect(titleFromSession(session, "新共创")).toBe("营销素材");
  });

  it("手动重命名后优先展示用户标题", () => {
    const session = {
      id: "s2",
      title: "我的方案讨论",
      titleManuallySet: true,
      messages: [
        {
          id: "m1",
          role: "user" as const,
          content: "请基于当前项目上下文，输出营销素材",
          userPrompt: "营销素材",
        },
      ],
      createdAt: 0,
      selectedProjectId: "p1",
      selectedCollection: "",
      includeProjectContext: true,
      includeKnowledgeContext: false,
      includeSkillsContext: false,
    } satisfies ChatSession;

    expect(titleFromSession(session, "新共创")).toBe("我的方案讨论");
  });
});

describe("isProjectCoCreateSession", () => {
  it("仅 sessionKind=project_co_create 视为共创", () => {
    expect(isProjectCoCreateSession({ sessionKind: "project_co_create" })).toBe(true);
    expect(isProjectCoCreateSession({ sessionKind: "chat" })).toBe(false);
    expect(isProjectCoCreateSession({})).toBe(false);
  });

  it("/chat 勾选项目+携带文件不应误判为共创", () => {
    const chatWithProjectFile = {
      sessionKind: "chat",
      chatMode: "co_create",
      selectedProjectId: "p1",
      includeFileContext: true,
    };
    expect(isProjectCoCreateSession(chatWithProjectFile)).toBe(false);
    expect(inferSessionKind(chatWithProjectFile)).toBe("chat");
  });
});

describe("isCoCreateSessionForProject", () => {
  it("仅匹配指定项目的共创会话", () => {
    expect(
      isCoCreateSessionForProject(
        { selectedProjectId: "p1", sessionKind: "project_co_create" },
        "p1",
      ),
    ).toBe(true);
    expect(
      isCoCreateSessionForProject(
        { selectedProjectId: "p2", sessionKind: "project_co_create" },
        "p1",
      ),
    ).toBe(false);
    expect(
      isCoCreateSessionForProject({ selectedProjectId: "p1", sessionKind: "chat" }, "p1"),
    ).toBe(false);
  });
});

describe("pickProjectCoCreateEntrySession", () => {
  const base = {
    selectedCollection: "",
    includeProjectContext: true,
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create" as const,
    includeFileContext: false,
    sessionKind: "project_co_create" as const,
    archived: false,
  };

  it("keeps active session when it already belongs to the project", () => {
    const active = {
      id: "active",
      title: "进行中",
      messages: [{ id: "u1", role: "user" as const, content: "继续写" }],
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    const empty = {
      id: "empty",
      title: "新共创",
      messages: [],
      createdAt: 200,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(
      pickProjectCoCreateEntrySession([active, empty], "project-1", active)?.id,
    ).toBe("active");
  });

  it("仅有空会话时落最新空壳（active 属其他项目）", () => {
    const otherProject = {
      id: "other",
      title: "知识问答",
      messages: [
        { id: "u1", role: "user" as const, content: "请基于当前项目上下文，输出可复用的知识问答与摘要" },
      ],
      createdAt: 300,
      selectedProjectId: "project-other",
      ...base,
    };
    const emptyOlder = {
      id: "empty-old",
      title: "新共创",
      messages: [],
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    const emptyNewer = {
      id: "empty-new",
      title: "新共创",
      messages: [],
      createdAt: 200,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(
      pickProjectCoCreateEntrySession(
        [otherProject, emptyOlder, emptyNewer],
        "project-1",
        otherProject,
      )?.id,
    ).toBe("empty-new");
  });

  it("优先有历史的会话，而非更新的空壳", () => {
    const emptyNewer = {
      id: "empty-new",
      title: "新共创",
      messages: [],
      createdAt: 300,
      selectedProjectId: "project-1",
      ...base,
    };
    const withHistory = {
      id: "with-history",
      title: "吉利越野架构",
      messages: [{ id: "u1", role: "user" as const, content: "吉利越野架构" }],
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(
      pickProjectCoCreateEntrySession([emptyNewer, withHistory], "project-1", null)?.id,
    ).toBe("with-history");
  });

  it("shell 仅有 messageCount 时也视为有历史", () => {
    const empty = {
      id: "empty",
      title: "新共创",
      messages: [],
      createdAt: 300,
      selectedProjectId: "project-1",
      ...base,
    };
    const shellWithHistory = {
      id: "shell",
      title: "吉利汽车",
      messages: [],
      messageCount: 2,
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(sessionHasPersistedMessages(shellWithHistory)).toBe(true);
    expect(sessionHasPersistedMessages(empty)).toBe(false);
    expect(
      pickProjectCoCreateEntrySession([empty, shellWithHistory], "project-1", null)?.id,
    ).toBe("shell");
  });

  it("多个有历史会话时取最新", () => {
    const older = {
      id: "older",
      title: "旧稿",
      messages: [{ id: "u1", role: "user" as const, content: "旧任务" }],
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    const newer = {
      id: "newer",
      title: "新稿",
      messages: [{ id: "u2", role: "user" as const, content: "新任务" }],
      createdAt: 200,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(
      pickProjectCoCreateEntrySession([older, newer], "project-1", null)?.id,
    ).toBe("newer");
  });
});

describe("pickBootstrapHydrateSessionId", () => {
  const base = {
    selectedCollection: "",
    includeProjectContext: true,
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create" as const,
    includeFileContext: false,
    sessionKind: "project_co_create" as const,
    archived: false,
    messages: [] as ChatSession["messages"],
  };

  it("preferredProjectId 时优先本项目有历史会话，而非其他项目 storedActive", () => {
    const other = {
      id: "other-active",
      title: "通用对话",
      createdAt: 300,
      selectedProjectId: "project-other",
      messageCount: 2,
      ...base,
    };
    const shellHistory = {
      id: "proj-history",
      title: "吉利汽车",
      createdAt: 100,
      selectedProjectId: "project-1",
      messageCount: 2,
      ...base,
    };
    const empty = {
      id: "proj-empty",
      title: "新共创",
      createdAt: 200,
      selectedProjectId: "project-1",
      messageCount: 0,
      ...base,
    };
    expect(
      pickBootstrapHydrateSessionId([other, shellHistory, empty], "other-active", "project-1"),
    ).toBe("proj-history");
  });

  it("storedActive 已属本项目时保持", () => {
    const a = {
      id: "a",
      title: "新共创",
      createdAt: 100,
      selectedProjectId: "project-1",
      ...base,
    };
    const b = {
      id: "b",
      title: "新共创",
      createdAt: 200,
      selectedProjectId: "project-1",
      ...base,
    };
    expect(pickBootstrapHydrateSessionId([a, b], "a", "project-1")).toBe("a");
  });
});

describe("listSurplusEmptyCoCreateSessionIds", () => {
  const base = {
    selectedCollection: "",
    includeProjectContext: true,
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create" as const,
    includeFileContext: false,
    sessionKind: "project_co_create" as const,
    archived: false,
    selectedProjectId: "project-1",
  };

  it("有历史时归档旧空壳，但保留最新空壳与 keepSessionId", () => {
    const history = {
      id: "hist",
      title: "吉利汽车",
      messages: [{ id: "u1", role: "user" as const, content: "吉利汽车" }],
      createdAt: 100,
      ...base,
    };
    const empty1 = {
      id: "e1",
      title: "新共创",
      messages: [],
      createdAt: 200,
      ...base,
    };
    const empty2 = {
      id: "e2",
      title: "新对话",
      messages: [],
      createdAt: 300,
      ...base,
    };
    expect(
      listSurplusEmptyCoCreateSessionIds([history, empty1, empty2], "project-1", {
        keepSessionId: "hist",
      }),
    ).toEqual(["e1"]);
  });

  it("仅有空壳时保留最新一个", () => {
    const older = {
      id: "old",
      title: "新共创",
      messages: [],
      createdAt: 100,
      ...base,
    };
    const newer = {
      id: "new",
      title: "新共创",
      messages: [],
      createdAt: 200,
      ...base,
    };
    expect(listSurplusEmptyCoCreateSessionIds([older, newer], "project-1")).toEqual(["old"]);
  });
});

describe("listAllSurplusEmptyCoCreateSessionIds", () => {
  const base = {
    selectedCollection: "",
    includeProjectContext: true,
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create" as const,
    includeFileContext: false,
    sessionKind: "project_co_create" as const,
    archived: false,
  };

  it("跨项目一次扫掉各项目多余空壳", () => {
    const sessions = [
      {
        id: "p1-hist",
        title: "吉利汽车",
        messages: [{ id: "u1", role: "user" as const, content: "吉利汽车" }],
        createdAt: 1,
        selectedProjectId: "p1",
        ...base,
      },
      {
        id: "p1-empty",
        title: "新共创",
        messages: [],
        createdAt: 2,
        selectedProjectId: "p1",
        ...base,
      },
      {
        id: "p2-empty-old",
        title: "新对话",
        messages: [],
        createdAt: 1,
        selectedProjectId: "p2",
        ...base,
      },
      {
        id: "p2-empty-new",
        title: "新共创",
        messages: [],
        createdAt: 2,
        selectedProjectId: "p2",
        ...base,
      },
      {
        id: "orphan-empty",
        title: "新共创",
        messages: [],
        createdAt: 3,
        selectedProjectId: "",
        ...base,
      },
    ];
    expect(listAllSurplusEmptyCoCreateSessionIds(sessions).sort()).toEqual([
      "orphan-empty",
      "p2-empty-old",
    ]);
  });
});
