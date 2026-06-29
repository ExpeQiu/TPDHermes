import { describe, expect, it } from "vitest";

import type { ScenarioListItem } from "@/lib/scenario-list";
import {
  buildWorkshopTaskInput,
  canSubmitWorkshop,
  getWorkshopSubmitBlockReason,
  isWorkshopSelectableScenario,
  resolveWorkshopDefaultScenarioId,
  sortWorkshopDisplayScenarios,
} from "@/lib/workshop-page";

function scenarioItem(
  id: string,
  title: string,
  status = "published",
  isLocalTemplate = false,
): ScenarioListItem {
  return {
    id,
    title,
    summary: `${title} summary`,
    goal: "g",
    recommendedTemplate: "t",
    recommendedKnowledgeMode: "off",
    recommendedSections: [],
    systemContext: "ctx",
    remote: isLocalTemplate
      ? null
      : {
          id,
          code: id,
          name: title,
          description: null,
          status,
          version: "1.0.0",
        },
    isLocalTemplate,
  };
}

describe("workshop-page helpers", () => {
  it("lists published scenarios without requiring a project", () => {
    const items = [
      scenarioItem("s-draft", "草稿", "draft"),
      scenarioItem("s-pub", "已发布"),
      scenarioItem("s-local", "内置", "published", true),
    ];
    const sorted = sortWorkshopDisplayScenarios(items, new Set(), new Set());
    expect(sorted.map((s) => s.id)).toEqual(["s-pub"]);
    expect(isWorkshopSelectableScenario(items[1])).toBe(true);
    expect(isWorkshopSelectableScenario(items[0])).toBe(false);
  });

  it("prioritizes quick and bound scenarios when sorting", () => {
    const items = [
      scenarioItem("c", "C场景"),
      scenarioItem("a", "A场景"),
      scenarioItem("b", "B场景"),
    ];
    const sorted = sortWorkshopDisplayScenarios(
      items,
      new Set(["b"]),
      new Set(["a"]),
    );
    expect(sorted.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("defaults scenario without project and respects url override", () => {
    const display = [scenarioItem("s1", "场景一"), scenarioItem("s2", "场景二")];
    expect(
      resolveWorkshopDefaultScenarioId({
        displayScenarios: display,
        selectedProjectId: "",
        scenarioFromUrl: "",
        currentScenarioId: "",
        projectQuickScenarios: null,
        boundScenarios: [],
      }),
    ).toBe("s1");

    expect(
      resolveWorkshopDefaultScenarioId({
        displayScenarios: display,
        selectedProjectId: "",
        scenarioFromUrl: "s2",
        currentScenarioId: "",
        projectQuickScenarios: null,
        boundScenarios: [],
      }),
    ).toBe("s2");
  });

  it("requires project and scenario before submit", () => {
    expect(
      getWorkshopSubmitBlockReason({
        selectedProjectId: "",
        selectedScenarioId: "s1",
        loadingBound: false,
        scenarioListItems: [scenarioItem("s1", "场景一")],
        loadingScenarioDetail: false,
        hasScenarioDetail: true,
        runSkillNames: ["hello_skill"],
        selectedSkill: null,
      }),
    ).toBe("请先选择关联项目");

    expect(
      canSubmitWorkshop({
        selectedProjectId: "p1",
        selectedScenarioId: "s1",
        loadingBound: false,
        scenarioListItems: [scenarioItem("s1", "场景一")],
        loadingScenarioDetail: false,
        hasScenarioDetail: true,
        runSkillNames: ["hello_skill"],
        selectedSkill: null,
        genStatus: "idle",
      }),
    ).toBe(true);
  });

  it("builds optional task input with auto title only", () => {
    const payload = buildWorkshopTaskInput({
      taskTitleCustom: "",
      derivedTaskTitle: "项目 · 场景 · 技能",
      taskBackground: "",
      taskObjective: "",
      taskKeywords: "",
      taskExtra: "",
      taskTone: "",
      mode: "generate",
      sourceMaterialPreview: null,
    });
    expect(payload).toEqual({ title: "项目 · 场景 · 技能" });
  });

  it("includes only filled optional task fields", () => {
    const payload = buildWorkshopTaskInput({
      taskTitleCustom: "自定义标题",
      derivedTaskTitle: "自动标题",
      taskBackground: "背景",
      taskObjective: "",
      taskKeywords: "a，b",
      taskExtra: "",
      taskTone: "正式",
      mode: "generate",
      sourceMaterialPreview: null,
    });
    expect(payload).toEqual({
      title: "自定义标题",
      background: "背景",
      keywords: ["a", "b"],
      tone: "正式",
    });
  });
});
