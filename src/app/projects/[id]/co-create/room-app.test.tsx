import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupDom, renderComponent } from "@/test-utils/component-test-utils";
import { waitFor } from "@/test-utils/hook-test-utils";
import CoCreateRoomApp from "./room-app";

const apiGet = vi.fn();
const apiPost = vi.fn();

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
}));

describe("CoCreateRoomApp", () => {
  afterEach(() => {
    cleanupDom();
    apiGet.mockReset();
    apiPost.mockReset();
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
  });
});
