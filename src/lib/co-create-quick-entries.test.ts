import { describe, expect, it } from "vitest";

import {
  buildCoCreateQuickEntries,
  buildCoCreateQuickPrompt,
  selectCoCreateQuickScenarios,
} from "@/lib/co-create-quick-entries";
import type { ScenarioListItem } from "@/lib/scenario-list";

function mockItem(
  id: string,
  title: string,
  status: string | null = "published",
): ScenarioListItem {
  return {
    id,
    title,
    summary: `${title} 说明`,
    goal: `输出 ${title}`,
    recommendedTemplate: "自定义",
    recommendedKnowledgeMode: "可选",
    recommendedSections: [],
    systemContext: `${title} 预设`,
    remote: status
      ? { id, code: id, name: title, description: null, status, version: "0.0.1" }
      : null,
    isLocalTemplate: !status,
  };
}

describe("buildCoCreateQuickPrompt", () => {
  it("为无「请」前缀的目标补上项目上下文", () => {
    expect(buildCoCreateQuickPrompt("输出技术方案")).toBe(
      "请基于当前项目上下文，输出技术方案",
    );
  });

  it("保留已有「请」前缀", () => {
    expect(buildCoCreateQuickPrompt("请生成报告")).toBe("请生成报告");
  });
});

describe("selectCoCreateQuickScenarios", () => {
  const items = [
    mockItem("a", "场景 A", "draft"),
    mockItem("b", "场景 B", "published"),
    mockItem("c", "场景 C", "published"),
  ];

  it("优先使用全局快捷创作入口", () => {
    const picked = selectCoCreateQuickScenarios(items, {
      globalQuickPrefs: { scenarioIds: ["a", "c"] },
    });
    expect(picked.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("其次使用项目快捷勾选", () => {
    const picked = selectCoCreateQuickScenarios(items, {
      projectQuickPrefs: { scenarioIds: ["a"], defaultScenarioId: "a" },
    });
    expect(picked.map((i) => i.id)).toEqual(["a"]);
  });

  it("无快捷勾选时仅取已发布场景", () => {
    const picked = selectCoCreateQuickScenarios(items, {});
    expect(picked.map((i) => i.id)).toEqual(["b", "c"]);
  });
});

describe("buildCoCreateQuickEntries", () => {
  it("映射标题与 accent", () => {
    const entries = buildCoCreateQuickEntries(
      [mockItem("x", "五看三定", "published")],
      { globalQuickPrefs: { scenarioIds: ["x"] } },
    );
    expect(entries[0]?.title).toBe("五看三定");
    expect(entries[0]?.scenarioId).toBe("x");
    expect(entries[0]?.accent).toMatch(/^from-/);
  });
});
