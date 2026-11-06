import { describe, expect, it } from "vitest";

import { collectionConfirmMatches } from "@/lib/kb-collection-catalog";

describe("collectionConfirmMatches", () => {
  const internal = "project.dd3c13a9.kb";
  const label = "test1 · 项目知识库";

  it("接受界面展示名", () => {
    expect(collectionConfirmMatches(label, [internal, label])).toBe(true);
  });

  it("接受内部合集名，以及带引号或条数后缀的粘贴", () => {
    expect(collectionConfirmMatches(internal, [internal, label])).toBe(true);
    expect(collectionConfirmMatches(`「${label}」`, [internal, label])).toBe(true);
    expect(collectionConfirmMatches(`${label}（3 条）`, [internal, label])).toBe(true);
  });

  it("不接受别的合集名", () => {
    expect(collectionConfirmMatches("项目知识库", [internal, label])).toBe(false);
    expect(collectionConfirmMatches("", [internal, label])).toBe(false);
  });
});
