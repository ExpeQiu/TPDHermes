import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, cleanupDom, clickElement, renderComponent, setInputValue } from "@/test-utils/component-test-utils";
import { waitFor } from "@/test-utils/hook-test-utils";
import CoCreateRoomApp, { readRoomComposerMention } from "./room-app";

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "project-1" }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/api", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
}));

describe("readRoomComposerMention", () => {
  it("@ 关联 Bot，# 引用文档，后出现的触发符生效", () => {
    expect(readRoomComposerMention("你好 @主")).toEqual({ kind: "role", query: "主" });
    expect(readRoomComposerMention("看一下 #共创")).toEqual({ kind: "file", query: "共创" });
    expect(readRoomComposerMention("#方案 @")).toEqual({ kind: "role", query: "" });
    expect(readRoomComposerMention("普通发言")).toBeNull();
  });
});

describe("CoCreateRoomApp", () => {
  afterEach(() => {
    cleanupDom();
    apiGet.mockReset();
    apiPost.mockReset();
    apiPatch.mockReset();
  });

  it("没有配置角色时指向 Roles", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/rooms/") && path.includes("/messages")) {
        return { messages: [], doc_version: 0, content: "", output_id: null };
      }
      if (path.endsWith("/rooms")) return { items: [] };
      if (path.includes("/brainstorm/roles")) return { items: [] };
      if (path.endsWith("/files")) return { items: [] };
      if (path.endsWith("/members")) return [];
      return {};
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("可以先建对话");
    });
    const modes = container.querySelector('[aria-label="创作模式"]');
    expect(modes?.textContent).toContain("Ask");
    expect(modes?.textContent).toContain("Agent");
    expect(modes?.textContent).toContain("Plan");
    const link = container.querySelector('a[href="/settings?tab=roles"]');
    expect(link).not.toBeNull();
    const create = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("新建对话"),
    );
    expect(create?.hasAttribute("disabled")).toBe(false);
  });

  it("打开对话后按序号展示成员和 Agent，并显示文档", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/messages")) {
        return {
          messages: [
            {
              id: "m2",
              seq: 2000,
              turn_id: "t2",
              author_type: "human",
              author_id: "bob",
              author_name: "bob",
              content: "后发言",
              turn_state: "done",
            },
            {
              id: "m1",
              seq: 1000,
              turn_id: "t1",
              author_type: "human",
              author_id: "ada",
              author_name: "ada",
              content: "先发言",
              turn_state: "done",
            },
            {
              id: "a1",
              seq: 1001,
              turn_id: "t1",
              author_type: "agent",
              author_id: "writer",
              author_name: "主笔",
              content: "主笔收束",
              turn_state: "done",
            },
          ],
          doc_version: 1,
          output_id: "out-1",
          content: "# 结果\n\n先发言",
        };
      }
      if (path.endsWith("/rooms")) {
        return {
          items: [
            {
              id: "room-1",
              title: "方案讨论",
              role_ids: ["writer"],
              writer_role_id: "writer",
              output_id: "out-1",
              doc_version: 1,
            },
          ],
        };
      }
      if (path.includes("/brainstorm/roles")) {
        return { items: [{ id: "writer", name: "主笔" }] };
      }
      if (path.endsWith("/files")) return { items: [] };
      if (path.endsWith("/members")) return [{ user_id: "ada", role: "owner" }];
      return {};
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("方案讨论");
    });
    const open = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("方案讨论"),
    );
    open?.click();
    await waitFor(() => {
      expect(container.textContent).toContain("先发言");
      expect(container.textContent).toContain("项目文件");
    });
    const text = container.textContent ?? "";
    expect(text.indexOf("先发言")).toBeLessThan(text.indexOf("主笔收束"));
    expect(text.indexOf("主笔收束")).toBeLessThan(text.indexOf("后发言"));
    expect(container.querySelector('[data-kind="member"][data-id="ada"]')?.getAttribute("data-voice")).toBe("on");
    expect(container.querySelector('[data-kind="member"][data-id="bob"]')?.getAttribute("data-voice")).toBe("on");
    expect(container.querySelector('[data-kind="bot"][data-id="writer"]')?.getAttribute("data-voice")).toBe("on");
  });

  it("@ 只列出 Bot，# 只列出文档", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/messages")) {
        return { messages: [], doc_version: 0, content: "", output_id: null };
      }
      if (path.endsWith("/rooms")) {
        return {
          items: [
            {
              id: "room-1",
              title: "方案讨论",
              role_ids: ["writer"],
              writer_role_id: "writer",
              output_id: null,
              doc_version: 0,
            },
          ],
        };
      }
      if (path.includes("/brainstorm/roles")) {
        return { items: [{ id: "writer", name: "主笔" }] };
      }
      if (path.endsWith("/files")) {
        return {
          items: [
            {
              id: "file-1",
              kind: "output",
              title: "共创文档.md",
              path: "/输出/共创文档.md",
              file_type: "md",
            },
          ],
        };
      }
      if (path.endsWith("/members")) return [];
      return {};
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("方案讨论");
    });
    const openRoom = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("方案讨论"),
    );
    openRoom?.click();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const optionLabels = () =>
      Array.from(container.querySelectorAll('[role="option"]')).map((node) => node.textContent ?? "");

    setValue("@");
    await waitFor(() => {
      const labels = optionLabels();
      expect(labels.some((label) => label.includes("主笔") && label.includes("Bot"))).toBe(true);
      expect(labels.some((label) => label.includes("入座"))).toBe(false);
      expect(labels.some((label) => label.includes("文档"))).toBe(false);
    });

    setValue("#共创");
    await waitFor(() => {
      const labels = optionLabels();
      expect(labels.some((label) => label.includes("共创文档.md") && label.includes("文档"))).toBe(true);
      expect(labels.some((label) => label.includes("Bot"))).toBe(false);
    });
  });

  it("@ 对未入座角色提供入座，并写回当前对话", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/messages")) {
        return { messages: [], doc_version: 0, content: "", output_id: null };
      }
      if (path.endsWith("/rooms")) {
        return {
          items: [
            {
              id: "room-1",
              title: "方案讨论",
              role_ids: [],
              writer_role_id: "",
              output_id: null,
              doc_version: 0,
            },
          ],
        };
      }
      if (path.includes("/brainstorm/roles")) {
        return { items: [{ id: "writer", name: "主笔" }] };
      }
      if (path.endsWith("/files")) return { items: [] };
      if (path.endsWith("/members")) return [];
      return {};
    });
    apiPatch.mockResolvedValue({
      id: "room-1",
      title: "方案讨论",
      role_ids: ["writer"],
      writer_role_id: "writer",
      output_id: null,
      doc_version: 0,
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("方案讨论");
    });
    const openRoom = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("方案讨论"),
    );
    openRoom?.click();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "@");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => {
      expect(container.textContent).toContain("入座");
      expect(container.textContent).not.toContain("当前对话没有入座角色");
    });
    const seat = Array.from(container.querySelectorAll('[role="option"]')).find((node) =>
      node.textContent?.includes("主笔"),
    );
    clickElement(seat as HTMLButtonElement);
    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledWith("/projects/project-1/rooms/room-1", {
        role_ids: ["writer"],
        writer_role_id: "writer",
      });
      expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("@主笔 ");
    });
  });

  it("可以改名并归档对话", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/messages")) {
        return { messages: [], doc_version: 0, content: "", output_id: null };
      }
      if (path.endsWith("/rooms")) {
        return {
          items: [
            {
              id: "room-1",
              title: "方案讨论",
              role_ids: [],
              writer_role_id: "",
              output_id: null,
              doc_version: 0,
              archived_at: null,
            },
          ],
        };
      }
      if (path.includes("/brainstorm/roles")) return { items: [] };
      if (path.endsWith("/files")) return { items: [] };
      if (path.endsWith("/members")) return [];
      return {};
    });
    apiPatch.mockImplementation(async (_path: string, body: { title?: string; archived?: boolean }) => {
      if (body.archived) {
        return {
          id: "room-1",
          title: "发布会讨论",
          role_ids: [],
          writer_role_id: "",
          output_id: null,
          doc_version: 0,
          archived_at: "2026-11-03T00:00:00",
        };
      }
      return {
        id: "room-1",
        title: body.title,
        role_ids: [],
        writer_role_id: "",
        output_id: null,
        doc_version: 0,
        archived_at: null,
      };
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("改名");
      expect(container.textContent).toContain("归档");
    });
    const rename = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "改名");
    expect(rename).toBeTruthy();
    clickElement(rename as HTMLButtonElement);
    await waitFor(() => {
      expect(container.querySelector('input[aria-label="对话名称"]')).not.toBeNull();
    });
    const input = container.querySelector('input[aria-label="对话名称"]') as HTMLInputElement;
    setInputValue(input, "发布会讨论");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledWith("/projects/project-1/rooms/room-1", { title: "发布会讨论" });
    });
    const archive = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "归档");
    clickElement(archive as HTMLButtonElement);
    await waitFor(() => {
      expect(apiPatch).toHaveBeenCalledWith("/projects/project-1/rooms/room-1", { archived: true });
      expect(container.textContent).toContain("已归档 1");
    });
  });

  it("发送中切换房间时，迟到响应不写进当前房间", async () => {
    let release: (value: unknown) => void = () => undefined;
    apiPost.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          if (String(path).includes("/messages")) release = resolve;
          else resolve({ id: "room-new", title: "新对话", role_ids: [], writer_role_id: "", doc_version: 0 });
        }),
    );
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/messages")) {
        return { messages: [], doc_version: 0, content: "", output_id: null };
      }
      if (path.endsWith("/rooms")) {
        return {
          items: [
            { id: "room-a", title: "房间甲", role_ids: [], writer_role_id: "", output_id: null, doc_version: 0 },
            { id: "room-b", title: "房间乙", role_ids: [], writer_role_id: "", output_id: null, doc_version: 0 },
          ],
        };
      }
      if (path.includes("/brainstorm/roles")) return { items: [] };
      if (path.endsWith("/files")) return { items: [] };
      if (path.endsWith("/members")) return [];
      return {};
    });
    const { container } = renderComponent(<CoCreateRoomApp />);
    await waitFor(() => {
      expect(container.textContent).toContain("房间甲");
    });
    const buttonNamed = (title: string) =>
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(title));
    buttonNamed("房间甲")?.click();
    const fill = (value: string) => {
      const node = container.querySelector("textarea") as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    };
    fill("甲的发言");
    clickElement(buttonNamed("发送") as HTMLButtonElement);
    buttonNamed("房间乙")?.click();
    fill("乙的草稿");
    await act(async () => {
      release({
        id: "late",
        seq: 1,
        turn_id: "t",
        author_type: "human",
        author_id: "a",
        author_name: "a",
        content: "迟到回复A",
        turn_state: "running",
      });
      await Promise.resolve();
    });
    expect(container.textContent ?? "").not.toContain("迟到回复A");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("乙的草稿");
  });
});
