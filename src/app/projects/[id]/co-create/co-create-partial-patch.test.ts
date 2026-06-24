import { describe, expect, it } from "vitest";
import {
  applyLineRangeLocally,
  applySearchReplaceLocally,
  buildRegionAwarePatchInstructions,
  computeFocusedLineDiff,
  focusDiffLines,
  resolvePatchAfterFromProposal,
} from "@/app/projects/[id]/co-create/co-create-partial-patch";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

describe("co-create-partial-patch", () => {
  it("buildRegionAwarePatchInstructions 含选段行号", () => {
    const text = buildRegionAwarePatchInstructions([
      { fileName: "a.md", startLine: 3, endLine: 5, text: "段落" },
    ]);
    expect(text).toContain("a.md L3-5");
    expect(text).toContain("search_replace");
  });

  it("applySearchReplaceLocally 唯一匹配", () => {
    const source = "第一行\n目标句\n第三行";
    expect(applySearchReplaceLocally(source, "目标句", "新句")).toBe("第一行\n新句\n第三行");
    expect(applySearchReplaceLocally(source, "不存在", "x")).toBeNull();
  });

  it("applyLineRangeLocally 替换行范围", () => {
    const source = "a\nb\nc\nd";
    expect(applyLineRangeLocally(source, 2, 3, "B\nC")).toBe("a\nB\nC\nd");
  });

  it("resolvePatchAfterFromProposal search_replace", () => {
    const proposal = {
      type: "patch",
      proposalId: "p1",
      fileId: "f1",
      fileKind: "output",
      fileName: "x.md",
      summary: "改",
      after: "",
      status: "proposed",
      editMode: "search_replace",
      oldString: "旧",
      newString: "新",
    } satisfies Extract<FileActionProposal, { type: "patch" }>;
    expect(resolvePatchAfterFromProposal(proposal, "前文旧后文")).toBe("前文新后文");
  });

  it("focusDiffLines 省略上下文外内容", () => {
    const lines = [
      { type: "equal" as const, text: "1" },
      { type: "equal" as const, text: "2" },
      { type: "remove" as const, text: "3" },
      { type: "add" as const, text: "4" },
      { type: "equal" as const, text: "5" },
      { type: "equal" as const, text: "6" },
    ];
    const focused = focusDiffLines(lines, 1);
    expect(focused.some((l) => l.text.includes("省略前"))).toBe(true);
  });

  it("computeFocusedLineDiff 有变更时收敛行数", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 10", "line TEN");
    const diff = computeFocusedLineDiff(before, after, 2);
    expect(diff.length).toBeLessThan(20);
    expect(diff.some((l) => l.type !== "equal")).toBe(true);
  });
});
