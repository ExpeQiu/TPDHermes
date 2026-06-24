import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupDom,
  clickElement,
  findByText,
  renderComponent,
  setInputValue,
} from "@/test-utils/component-test-utils";
import { ProjectFilesPanel } from "./ProjectFilesPanel";

describe("ProjectFilesPanel", () => {
  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("renders loading state and empty state", () => {
    const loadingView = renderComponent(
      React.createElement(ProjectFilesPanel, {
        files: [],
        loading: true,
        openTabKeys: [],
        activeFileKey: null,
        pinnedFileIds: [],
        roundFileIds: [],
        onSelectPreview: () => {},
        onRefresh: () => {},
      }),
    );

    expect(loadingView.container.textContent).toContain("加载文件…");
    loadingView.unmount();

    const emptyView = renderComponent(
      React.createElement(ProjectFilesPanel, {
        files: [],
        loading: false,
        openTabKeys: [],
        activeFileKey: null,
        pinnedFileIds: [],
        roundFileIds: [],
        onSelectPreview: () => {},
        onRefresh: () => {},
      }),
    );

    expect(emptyView.container.textContent).toContain("暂无项目文件");
    expect(emptyView.container.textContent).toContain("让 Agent 生成初始文件");
  });

  it("filters, searches, refreshes, and selects preview items", () => {
    const onSelectPreview = vi.fn();
    const onRefresh = vi.fn();

    const { container } = renderComponent(
      React.createElement(ProjectFilesPanel, {
        files: [
          {
            id: "out-1",
            kind: "output",
            title: "方案草稿.md",
            path: "/输出/方案草稿.md",
            file_type: "markdown",
            summary: "品牌策略版本",
          },
          {
            id: "att-1",
            kind: "attachment",
            title: "brief.txt",
            path: "/附件/brief.txt",
            file_type: "text",
            summary: "索引: ingested",
          },
        ],
        loading: false,
        openTabKeys: ["output:out-1"],
        activeFileKey: "output:out-1",
        pinnedFileIds: ["output:out-1"],
        roundFileIds: ["attachment:att-1"],
        onSelectPreview,
        onRefresh,
      }),
    );

    expect(container.textContent).toContain("项目文件");
    expect(container.textContent).toContain("方案草稿.md");
    expect(container.textContent).toContain("brief.txt");
    expect(container.textContent).toContain("固定");
    expect(container.textContent).toContain("本轮");
    expect(container.querySelector('[title="已打开"]')).not.toBeNull();

    clickElement(findByText(container, "刷新")!);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    clickElement(findByText(container, "附件")!);
    expect(container.textContent).toContain("brief.txt");
    expect(container.textContent).not.toContain("方案草稿.md");

    clickElement(findByText(container, "全部")!);
    const searchInput = container.querySelector('input[placeholder="搜索文件…"]') as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    setInputValue(searchInput, "brief");
    expect(container.textContent).toContain("brief.txt");
    expect(container.textContent).not.toContain("方案草稿.md");

    setInputValue(searchInput, "策略");
    expect(container.textContent).toContain("方案草稿.md");
    expect(container.textContent).not.toContain("brief.txt");

    clickElement(findByText(container, "方案草稿.md")!);
    expect(onSelectPreview).toHaveBeenCalledWith("output:out-1");
  });

  it("filters to output files only and allows selecting attachments in all mode", () => {
    const onSelectPreview = vi.fn();

    const { container } = renderComponent(
      React.createElement(ProjectFilesPanel, {
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
        loading: false,
        openTabKeys: [],
        activeFileKey: null,
        pinnedFileIds: [],
        roundFileIds: [],
        onSelectPreview,
        onRefresh: () => {},
      }),
    );

    clickElement(findByText(container, "输出物")!);
    expect(container.textContent).toContain("方案草稿.md");
    expect(container.textContent).not.toContain("brief.txt");

    clickElement(findByText(container, "全部")!);
    clickElement(findByText(container, "brief.txt")!);
    expect(onSelectPreview).toHaveBeenCalledWith("attachment:att-1");
  });
});
