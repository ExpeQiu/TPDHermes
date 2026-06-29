import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoCreateQuickEntry } from "@/lib/co-create-quick-entries";
import {
  cleanupDom,
  clickElement,
  findByText,
  renderComponent,
} from "@/test-utils/component-test-utils";
import { CoCreateMessageStream } from "./CoCreateMessageStream";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => React.createElement("a", { href, ...props }, children),
}));

vi.mock("@/components/chat-markdown-with-citations", () => ({
  ChatMarkdownWithCitations: () => null,
}));

vi.mock("@/components/streaming-wait-hint", () => ({
  StreamingWaitHint: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/AgentActivityTimeline", () => ({
  AgentActivityTimeline: () => null,
}));

vi.mock("@/app/projects/[id]/co-create/components/AgentPlanCard", () => ({
  AgentPlanCard: () => null,
}));

const quickEntries: CoCreateQuickEntry[] = [
  {
    id: "five-look",
    scenarioId: "five-look",
    title: "五看三定挖掘技术亮点",
    prompt: "请基于当前项目上下文，挖掘技术亮点。",
    presetInstructions: "五看三定方法论",
    accent: "from-blue-600 to-indigo-600",
  },
  {
    id: "benchmark",
    scenarioId: "benchmark",
    title: "竞品对标",
    prompt: "请基于当前项目上下文，生成竞品对标分析。",
    presetInstructions: "对标表",
    accent: "from-amber-600 to-orange-600",
  },
];

describe("CoCreateMessageStream quick entries", () => {
  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("空会话时展示快捷创作入口卡片", () => {
    const { container } = renderComponent(
      React.createElement(CoCreateMessageStream, {
        messages: [],
        quickEntries,
        moreHref: "/create?return_project_id=p-1",
      }),
    );

    expect(findByText(container, "快捷创作入口")).not.toBeNull();
    expect(findByText(container, "五看三定挖掘技术亮点")).not.toBeNull();
    expect(findByText(container, "竞品对标")).not.toBeNull();
    expect(container.querySelector('a[href="/create?return_project_id=p-1"]')).not.toBeNull();
  });

  it("点击快捷入口触发 onQuickStart 并传递完整 entry", () => {
    const onQuickStart = vi.fn();
    const { container } = renderComponent(
      React.createElement(CoCreateMessageStream, {
        messages: [],
        quickEntries,
        onQuickStart,
      }),
    );

    const button = findByText(container, "竞品对标");
    expect(button).not.toBeNull();
    clickElement(button!);

    expect(onQuickStart).toHaveBeenCalledTimes(1);
    expect(onQuickStart).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioId: "benchmark",
        title: "竞品对标",
      }),
    );
  });

  it("加载中与无场景时展示占位文案", () => {
    const loading = renderComponent(
      React.createElement(CoCreateMessageStream, {
        messages: [],
        quickEntries: [],
        quickEntriesLoading: true,
      }),
    );
    expect(findByText(loading.container, "加载场景列表…")).not.toBeNull();
    loading.unmount();

    const empty = renderComponent(
      React.createElement(CoCreateMessageStream, {
        messages: [],
        quickEntries: [],
      }),
    );
    expect(empty.container.textContent).toContain("暂无可用场景");
    expect(empty.container.textContent).toContain("场景编排");
  });

  it("有消息时不展示快捷入口", () => {
    const { container } = renderComponent(
      React.createElement(CoCreateMessageStream, {
        messages: [{ id: "u1", role: "user", content: "你好" }],
        quickEntries,
      }),
    );

    expect(findByText(container, "快捷创作入口")).toBeNull();
  });
});
