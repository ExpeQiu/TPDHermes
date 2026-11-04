import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, clickElement, renderComponent } from "@/test-utils/component-test-utils";
import { waitFor } from "@/test-utils/hook-test-utils";
import { createStudioState } from "@/lib/tech-card-studio";
import StudioClient, { SourcePane } from "./studio-client";

const apiGet = vi.fn();
const apiPost = vi.fn();
const files = vi.fn();
const detail = vi.fn();
vi.mock("@/lib/api", () => ({ apiGet: (...args: unknown[]) => apiGet(...args), apiPost: (...args: unknown[]) => apiPost(...args) }));
vi.mock("@/lib/co-create-api", () => ({ fetchProjectFilesUnified: (...args: unknown[]) => files(...args), fetchProjectFileDetail: (...args: unknown[]) => detail(...args) }));
vi.mock("@/components/project-files-rail", () => ({ ProjectFilesRail: ({ onFileChange }: { onFileChange: (id: string) => void }) => <div><button onClick={() => onFileChange("output:a")}>选文件A</button><button onClick={() => onFileChange("output:b")}>选文件B</button></div> }));

const mounts: (() => void)[] = [];
const mount = (element = <StudioClient initialProjectId="p1" />) => {
  const view = renderComponent(element); mounts.push(view.unmount); return view.container;
};
const click = (container: HTMLElement, text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === text);
  if (!button) throw new Error(`missing button: ${text}`);
  clickElement(button);
};
const response = () => ({
  driver: "tpcstore", fallback_reason: null, log: {}, reply: "从文件A取得候选", source: { id: "a", version: "1", text: "原文A技术采用分层设计。", sha256: "hash-a" },
  state: { ...createStudioState(), revision: 1, source_sha256: "hash-a", selectedCardId: "c1", selectedField: "definition", cards: [{ id: "c1", term: "原文A技术", aliases: [], domain: "夹具", definition: "采用分层设计", principle: "", parameter: "", scope: "", status: "candidate", quotes: { definition: "采用分层设计", principle: "", parameter: "", scope: "" }, sources: { definition: { source_id: "a", line_start: 1, line_end: 1, quote: "采用分层设计" } } }] },
});

beforeEach(() => {
  apiGet.mockImplementation(async (path: string) => path === "/projects/" ? [{ id: "p1", name: "项目一" }] : { driver: "tpcstore", connected: true, configured: true });
  files.mockResolvedValue([]);
  detail.mockImplementation(async (_project: string, id: string) => ({ id, title: `文件${id}`, content: id === "a" ? "原文A技术采用分层设计。" : "原文B技术采用另一种结构。" }));
});
afterEach(() => {
  mounts.splice(0).forEach(unmount => unmount());
  vi.resetAllMocks();
});

describe("TPCstore Studio 通路", () => {
  it("项目直达后提交实际文件，回显真实候选与行号", async () => {
    apiPost.mockResolvedValue(response());
    const container = mount();
    await waitFor(() => expect(files).toHaveBeenCalledWith("p1"));
    click(container, "选文件A");
    await waitFor(() => expect(container.textContent).toContain("原文A技术采用分层设计"));
    click(container, "提取技术卡");
    await waitFor(() => expect(container.textContent).toContain("从文件A取得候选"));
    expect(apiPost.mock.calls[0][1]).toMatchObject({ project_id: "p1", file_id: "a", file_kind: "output", demo: false });
    expect(container.querySelector("mark")?.textContent).toBe("采用分层设计");
    expect(container.textContent).toContain("L1–L1");
    expect(container.textContent).toContain("未持久保存");
  });

  it("真实错误显示原错误，不产生本地样本卡", async () => {
    apiPost.mockRejectedValue(new Error("TPCstore AUTH_REQUIRED：网关认证失败"));
    const container = mount();
    click(container, "选文件A");
    await waitFor(() => expect(container.textContent).toContain("原文A技术采用分层设计"));
    click(container, "提取技术卡");
    await waitFor(() => expect(container.textContent).toContain("AUTH_REQUIRED"));
    expect(container.textContent).not.toContain("800V 高压平台");
    expect(container.textContent).toContain("还没有候选");
  });

  it("换文件后迟到结果不能污染新工作区", async () => {
    let complete: (value: unknown) => void = () => {};
    apiPost.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const container = mount();
    click(container, "选文件A");
    await waitFor(() => expect(container.textContent).toContain("原文A技术采用分层设计"));
    click(container, "提取技术卡");
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    click(container, "选文件B");
    await waitFor(() => expect(container.textContent).toContain("原文B技术"));
    await act(async () => { complete(response()); });
    expect(container.textContent).not.toContain("从文件A取得候选");
    expect(container.textContent).not.toContain("原文A技术");
  });

  it("重复原文按指定行定位", () => {
    const container = mount(<SourcePane text={"相同原文\n其他\n相同原文"} quote="相同原文" lineStart={3} />);
    const mark = container.querySelector("mark")!;
    expect(mark.previousSibling?.textContent).toBe("相同原文\n其他\n");
  });
});
