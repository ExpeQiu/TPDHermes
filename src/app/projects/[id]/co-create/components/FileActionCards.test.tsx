import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupDom,
  clickElement,
  findByText,
  renderComponent,
} from "@/test-utils/component-test-utils";
import { FileCreateCard } from "./FileCreateCard";
import { FilePatchCard } from "./FilePatchCard";
import { UpdateToOutputDialog } from "./UpdateToOutputDialog";

describe("File action cards", () => {
  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("renders create proposal actions without content preview", () => {
    const onCreateNew = vi.fn();
    const onUpdateTo = vi.fn();
    const onCancel = vi.fn();

    const { container } = renderComponent(
      React.createElement(FileCreateCard, {
        proposal: {
          type: "create",
          proposalId: "create-1",
          fileName: "新文稿.md",
          path: "/输出/新文稿.md",
          content: "# 计划\n\n生成正文不应展示",
          status: "failed",
        },
        onCreateNew,
        onUpdateTo,
        onCancel,
      }),
    );

    expect(container.textContent).toContain("自动创建失败");
    expect(container.textContent).toContain("新文稿.md");
    expect(container.textContent).not.toContain("生成正文不应展示");
    expect(container.textContent).toContain("重试创建新文件");
    expect(container.textContent).toContain("更新到");
    expect(container.textContent).toContain("创建新文件");

    clickElement(findByText(container, "重试创建新文件")!);
    clickElement(findByText(container, "更新到")!);
    clickElement(findByText(container, "取消")!);

    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(onUpdateTo).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("UpdateToOutputDialog lists outputs and forwards selection", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const { container } = renderComponent(
      React.createElement(UpdateToOutputDialog, {
        open: true,
        fileName: "新文稿.md",
        outputs: [
          {
            id: "out-1",
            kind: "output",
            title: "方案草稿.md",
            path: "/输出/方案草稿.md",
            file_type: "markdown",
          },
        ],
        onSelect,
        onClose,
      }),
    );

    expect(container.textContent).toContain("更新到输出物");
    expect(container.textContent).toContain("方案草稿.md");

    clickElement(findByText(container, "方案草稿.md")!);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "out-1", title: "方案草稿.md" }),
    );
  });

  it("renders applied patch state and keeps only diff viewing available", () => {
    const onViewDiff = vi.fn();
    const onApply = vi.fn();
    const onSaveVersion = vi.fn();
    const onSaveCopy = vi.fn();
    const onCancel = vi.fn();

    const { container } = renderComponent(
      React.createElement(FilePatchCard, {
        proposal: {
          type: "patch",
          proposalId: "patch-1",
          fileId: "out-1",
          fileKind: "output",
          fileName: "方案草稿.md",
          summary: "补充执行摘要",
          after: "# 第二版",
          status: "applied",
        },
        onViewDiff,
        onApply,
        onSaveVersion,
        onSaveCopy,
        onCancel,
      }),
    );

    expect(container.textContent).toContain("Agent 已修改文件");
    expect(findByText(container, "覆盖保存")).toBeNull();

    clickElement(findByText(container, "查看 Diff")!);
    expect(onViewDiff).toHaveBeenCalledTimes(1);
  });

  it("renders proposed patch actions and forwards all button callbacks", () => {
    const onViewDiff = vi.fn();
    const onApply = vi.fn();
    const onSaveVersion = vi.fn();
    const onSaveCopy = vi.fn();
    const onCancel = vi.fn();

    const { container } = renderComponent(
      React.createElement(FilePatchCard, {
        proposal: {
          type: "patch",
          proposalId: "patch-2",
          fileId: "out-2",
          fileKind: "output",
          fileName: "执行稿.md",
          summary: "压缩重复段落",
          after: "# 新版本",
          status: "proposed",
        },
        onViewDiff,
        onApply,
        onSaveVersion,
        onSaveCopy,
        onCancel,
      }),
    );

    clickElement(findByText(container, "查看 Diff")!);
    clickElement(findByText(container, "覆盖保存")!);
    clickElement(findByText(container, "另存为独立文件")!);
    clickElement(findByText(container, "另存为副本")!);
    clickElement(findByText(container, "忽略")!);

    expect(onViewDiff).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onSaveVersion).toHaveBeenCalledTimes(1);
    expect(onSaveCopy).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
