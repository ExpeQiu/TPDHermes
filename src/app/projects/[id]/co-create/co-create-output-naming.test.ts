import { describe, expect, it } from "vitest";

import {
  isOutputTitleTaken,
  normalizeOutputFileStem,
  resolveUniqueOutputFileName,
} from "@/app/projects/[id]/co-create/co-create-output-naming";

describe("co-create-output-naming", () => {
  it("treats titles with and without .md as the same stem", () => {
    expect(normalizeOutputFileStem("通用对话.md")).toBe("通用对话");
    expect(normalizeOutputFileStem("通用对话")).toBe("通用对话");
    expect(isOutputTitleTaken("通用对话.md", ["通用对话"])).toBe(true);
    expect(isOutputTitleTaken("通用对话", ["通用对话.md"])).toBe(true);
  });

  it("appends numeric suffix when base name is taken", () => {
    expect(resolveUniqueOutputFileName("产品需求文档", ["产品需求文档", "产品需求文档.md"])).toBe(
      "产品需求文档-2.md",
    );
    expect(
      resolveUniqueOutputFileName("产品需求文档", [
        "产品需求文档.md",
        "产品需求文档-2.md",
      ]),
    ).toBe("产品需求文档-3.md");
  });

  it("returns normalized name when no conflict", () => {
    expect(resolveUniqueOutputFileName("新方案说明", ["通用对话.md"])).toBe("新方案说明.md");
  });
});
