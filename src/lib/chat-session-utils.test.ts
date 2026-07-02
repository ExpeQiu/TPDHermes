import { describe, expect, it } from "vitest";

import type { ChatSession } from "@/app/chat/chat-types";
import {
  condenseTopicTitle,
  isProjectCoCreateSession,
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
