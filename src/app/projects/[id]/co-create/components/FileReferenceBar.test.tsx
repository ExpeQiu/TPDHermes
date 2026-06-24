import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupDom,
  clickElement,
  findAllByText,
  renderComponent,
} from "@/test-utils/component-test-utils";
import { FileReferenceBar } from "./FileReferenceBar";

describe("FileReferenceBar", () => {
  afterEach(() => {
    cleanupDom();
    vi.clearAllMocks();
  });

  it("renders empty state when no file references exist", () => {
    const { container } = renderComponent(
      React.createElement(FileReferenceBar, {
        pinnedFileIds: [],
        roundFileIds: [],
        files: [],
        onRemove: () => {},
      }),
    );

    expect(container.textContent).toContain("尚未引用文件");
    expect(container.textContent).toContain("加入本轮");
    expect(container.textContent).toContain("固定引用");
  });

  it("renders pinned and round references and removes them with correct scope", () => {
    const onRemove = vi.fn();

    const { container } = renderComponent(
      React.createElement(FileReferenceBar, {
        pinnedFileIds: ["output:out-1", "output:missing-output-id"],
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
        onRemove,
      }),
    );

    expect(container.textContent).toContain("固定引用：");
    expect(container.textContent).toContain("本轮引用：");
    expect(container.textContent).toContain("方案草稿.md");
    expect(container.textContent).toContain("brief.txt");
    expect(container.textContent).toContain("missing-");

    const removeButtons = findAllByText(container, "×");
    expect(removeButtons).toHaveLength(3);

    clickElement(removeButtons[0]);
    clickElement(removeButtons[1]);
    clickElement(removeButtons[2]);

    expect(onRemove).toHaveBeenNthCalledWith(1, "output:out-1", "pinned");
    expect(onRemove).toHaveBeenNthCalledWith(2, "output:missing-output-id", "pinned");
    expect(onRemove).toHaveBeenNthCalledWith(3, "attachment:att-1", "round");
  });

  it("supports embedded rendering without the block wrapper", () => {
    const { container } = renderComponent(
      React.createElement(FileReferenceBar, {
        embedded: true,
        pinnedFileIds: ["output:out-1"],
        roundFileIds: [],
        files: [
          {
            id: "out-1",
            kind: "output",
            title: "方案草稿.md",
            path: "/输出/方案草稿.md",
            file_type: "markdown",
          },
        ],
        onRemove: () => {},
      }),
    );

    expect(container.firstElementChild?.tagName).toBe("SPAN");
    expect(container.textContent).toContain("固定引用：");
    expect(container.textContent).toContain("方案草稿.md");
  });
});
