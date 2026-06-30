import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderHook, waitFor } from "@/test-utils/hook-test-utils";
import { useFileWorkspace } from "./use-file-workspace";

const apiMocks = vi.hoisted(() => ({
  fetchProjectFilesUnified: vi.fn(),
  fetchProjectFileDetail: vi.fn(),
  fetchProjectFileVersions: vi.fn(),
}));

vi.mock("@/lib/co-create-api", () => ({
  fetchProjectFilesUnified: apiMocks.fetchProjectFilesUnified,
  fetchProjectFileDetail: apiMocks.fetchProjectFileDetail,
  fetchProjectFileVersions: apiMocks.fetchProjectFileVersions,
}));

describe("useFileWorkspace", () => {
  beforeEach(() => {
    apiMocks.fetchProjectFilesUnified.mockReset();
    apiMocks.fetchProjectFileDetail.mockReset();
    apiMocks.fetchProjectFileVersions.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads project files and opens an output tab with detail and versions", async () => {
    apiMocks.fetchProjectFilesUnified.mockResolvedValue([
      {
        id: "out-1",
        kind: "output",
        title: "方案草稿.md",
        path: "/输出/方案草稿.md",
        file_type: "markdown",
      },
    ]);
    apiMocks.fetchProjectFileDetail.mockResolvedValue({
      id: "out-1",
      kind: "output",
      title: "方案草稿.md",
      path: "/输出/方案草稿.md",
      file_type: "markdown",
      content: "# 第一版",
      content_format: "markdown",
      version: "1",
    });
    apiMocks.fetchProjectFileVersions.mockResolvedValue([
      {
        id: "out-1",
        version: "1",
        title: "方案草稿.md",
        created_at: "2026-06-24T10:00:00",
        updated_at: "2026-06-24T10:00:00",
      },
    ]);

    const { result } = renderHook(() => useFileWorkspace("project-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.files).toHaveLength(1);
    expect(apiMocks.fetchProjectFilesUnified).toHaveBeenCalledWith("project-1");

    act(() => {
      result.current.openFileTab("output:out-1");
    });

    await waitFor(() => expect(result.current.previewDetail?.content).toBe("# 第一版"));
    expect(result.current.activeFileKey).toBe("output:out-1");
    expect(result.current.tabLabels["output:out-1"]).toBe("方案草稿.md");
    expect(result.current.versions).toHaveLength(1);
    expect(apiMocks.fetchProjectFileDetail).toHaveBeenCalledWith("project-1", "out-1", "output");
    expect(apiMocks.fetchProjectFileVersions).toHaveBeenCalledWith(
      "project-1",
      "out-1",
      "output",
    );

    act(() => {
      result.current.patchTabContent("output:out-1", "# 第二版");
    });

    expect(result.current.previewDetail?.content).toBe("# 第二版");
  });

  it("keeps tabs unique, skips attachment versions, and restores the previous active tab on close", async () => {
    apiMocks.fetchProjectFilesUnified.mockResolvedValue([
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
    ]);
    apiMocks.fetchProjectFileDetail.mockImplementation(async (_projectId: string, fileId: string) => {
      if (fileId === "out-1") {
        return {
          id: "out-1",
          kind: "output",
          title: "方案草稿.md",
          path: "/输出/方案草稿.md",
          file_type: "markdown",
          content: "# 第一版",
          content_format: "markdown",
          version: "1",
        };
      }
      return {
        id: "att-1",
        kind: "attachment",
        title: "brief.txt",
        path: "/附件/brief.txt",
        file_type: "text",
        content: "附件正文",
        content_format: "text",
        version: null,
      };
    });
    apiMocks.fetchProjectFileVersions.mockResolvedValue([
      {
        id: "out-1",
        version: "1",
        title: "方案草稿.md",
        created_at: "2026-06-24T10:00:00",
        updated_at: "2026-06-24T10:00:00",
      },
    ]);

    const { result } = renderHook(() => useFileWorkspace("project-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.openFileTab("output:out-1");
      result.current.openFileTab("output:out-1");
    });

    await waitFor(() => expect(result.current.previewDetail?.id).toBe("out-1"));
    expect(result.current.openTabKeys).toEqual(["output:out-1"]);

    act(() => {
      result.current.openFileTab("attachment:att-1");
    });

    await waitFor(() => expect(result.current.previewDetail?.id).toBe("att-1"));
    expect(result.current.openTabKeys).toEqual(["output:out-1", "attachment:att-1"]);
    expect(result.current.versions).toEqual([]);
    expect(apiMocks.fetchProjectFileVersions).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.closeFileTab("attachment:att-1");
    });

    expect(result.current.openTabKeys).toEqual(["output:out-1"]);
    expect(result.current.activeFileKey).toBe("output:out-1");
  });

  it("clears open tabs when projectId changes", async () => {
    apiMocks.fetchProjectFilesUnified.mockResolvedValue([
      {
        id: "out-1",
        kind: "output",
        title: "方案草稿.md",
        path: "/输出/方案草稿.md",
        file_type: "markdown",
      },
    ]);
    apiMocks.fetchProjectFileDetail.mockResolvedValue({
      id: "out-1",
      kind: "output",
      title: "方案草稿.md",
      path: "/输出/方案草稿.md",
      file_type: "markdown",
      content: "# 第一版",
      content_format: "markdown",
      version: "1",
    });
    apiMocks.fetchProjectFileVersions.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useFileWorkspace(projectId),
      { initialProps: { projectId: "project-1" } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.openFileTab("output:out-1");
    });

    await waitFor(() => expect(result.current.activeFileKey).toBe("output:out-1"));

    rerender({ projectId: "project-2" });

    await waitFor(() => expect(result.current.openTabKeys).toEqual([]));
    expect(result.current.activeFileKey).toBeNull();
    expect(apiMocks.fetchProjectFilesUnified).toHaveBeenCalledWith("project-2");
  });
});
