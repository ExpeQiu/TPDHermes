import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupDom,
  clickElement,
  findAllByText,
  findByText,
  renderComponent,
} from "@/test-utils/component-test-utils";
import { CoCreateTopbar } from "./CoCreateTopbar";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    React.createElement("a", { href, ...props }, children)
  ),
}));

describe("CoCreateTopbar", () => {
  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("renders project context, file references, toolbar, save state, and project navigation", () => {
    const onRemoveFileRef = vi.fn();
    const onToggleSessions = vi.fn();
    const onToggleFilesPanel = vi.fn();
    const onUndoAgentChange = vi.fn();

    const { container } = renderComponent(
      React.createElement(CoCreateTopbar, {
        projectName: "Hermes 共创项目",
        projectId: "p-1",
        saveState: "pending_apply",
        agentChangeSummary: "最近一次 AI 变更：补充了摘要段落",
        onUndoAgentChange,
        undoCount: 2,
        onToggleSessions,
        sessionsOpen: false,
        onToggleFilesPanel,
        filesPanelOpen: true,
        projectContext: {
          project_id: "p-1",
          name: "Hermes 共创项目",
          description: "desc",
          background: "bg",
          audience: "team",
          attachments: [],
          recent_outputs: [],
          kb_stats: {
            collection: "project.p-1.kb",
            attachments_indexed: 0,
            outputs_indexed: 2,
          },
        },
        projectContextLoadState: "ready",
        outputCount: 2,
        pinnedFileIds: ["output:out-1"],
        roundFileIds: ["attachment:att-1"],
        files: [
          {
            id: "out-1",
            kind: "output",
            title: "方案草稿.md",
            path: "/输出/方案草稿.md",
            file_type: "markdown",
          },
          {
            id: "att-1",
            kind: "attachment",
            title: "brief.txt",
            path: "/附件/brief.txt",
            file_type: "text",
          },
        ],
        onRemoveFileRef,
      }),
    );

    expect(container.textContent).toContain("项目：Hermes 共创项目");
    expect(container.textContent).toContain("项目上下文：已启用");
    expect(container.textContent).toContain("最近输出：2");
    expect(container.textContent).toContain("固定引用：");
    expect(container.textContent).toContain("方案草稿.md");
    expect(container.textContent).toContain("本轮引用：");
    expect(container.textContent).toContain("brief.txt");
    expect(container.textContent).toContain("Agent 正在应用");
    expect(container.textContent).toContain("最近一次 AI 变更：补充了摘要段落");

    const undoButton = container.querySelector('button[aria-label^="撤销 Agent 变更"]');
    const sessionToggle = container.querySelector('button[aria-label="显示会话栏"]');
    const filesToggle = container.querySelector('button[aria-label="隐藏项目文件"]');
    const projectLink = findByText(container, "← 项目") as HTMLAnchorElement | null;
    const removeButtons = findAllByText(container, "×");

    expect(undoButton).not.toBeNull();
    expect(sessionToggle).not.toBeNull();
    expect(filesToggle).not.toBeNull();
    expect(projectLink?.getAttribute("href")).toBe("/projects/p-1");
    expect(removeButtons).toHaveLength(2);

    clickElement(undoButton!);
    clickElement(sessionToggle!);
    clickElement(filesToggle!);
    clickElement(removeButtons[0]);
    clickElement(removeButtons[1]);

    expect(onUndoAgentChange).toHaveBeenCalledTimes(1);
    expect(onToggleSessions).toHaveBeenCalledTimes(1);
    expect(onToggleFilesPanel).toHaveBeenCalledTimes(1);
    expect(onRemoveFileRef).toHaveBeenNthCalledWith(1, "output:out-1", "pinned");
    expect(onRemoveFileRef).toHaveBeenNthCalledWith(2, "attachment:att-1", "round");
  });

  it("renders loading context and hidden session toggle state when context is absent", () => {
    const { container } = renderComponent(
      React.createElement(CoCreateTopbar, {
        projectName: "Hermes 共创项目",
        projectId: "p-2",
        saveState: "saved",
        sessionsOpen: true,
        filesPanelOpen: false,
        projectContext: null,
        projectContextLoadState: "loading",
        outputCount: 0,
        pinnedFileIds: [],
        roundFileIds: [],
        files: [],
        onRemoveFileRef: () => {},
        onToggleSessions: () => {},
        onToggleFilesPanel: () => {},
      }),
    );

    expect(container.textContent).toContain("项目上下文：加载中…");
    expect(container.textContent).toContain("最近输出：0");
    expect(container.textContent).toContain("尚未引用文件");
    expect(container.textContent).toContain("已自动保存");
    expect(container.querySelector('button[aria-label="隐藏会话栏"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="显示项目文件"]')).not.toBeNull();
  });

  it("renders unavailable context when context load failed", () => {
    const { container } = renderComponent(
      React.createElement(CoCreateTopbar, {
        projectName: "Hermes 共创项目",
        projectId: "p-3",
        saveState: "idle",
        projectContext: null,
        projectContextLoadState: "error",
        outputCount: 0,
        pinnedFileIds: [],
        roundFileIds: [],
        files: [],
        onRemoveFileRef: () => {},
      }),
    );

    expect(container.textContent).toContain("项目上下文：不可用");
  });
});
