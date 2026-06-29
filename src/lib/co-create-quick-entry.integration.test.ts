import { beforeEach, describe, expect, it } from "vitest";

import { buildCoCreateQuickStartPlan } from "@/app/projects/[id]/co-create/co-create-quick-start";
import { buildCoCreateQuickEntries } from "@/lib/co-create-quick-entries";
import {
  saveCoCreateQuickScenariosPrefs,
  toggleCoCreateQuickScenario,
} from "@/lib/co-create-quick-scenarios-prefs";
import { scenarioFromRemoteRow, type ScenarioApiRow } from "@/lib/scenario-list";

const SCOPE = "integration-user";

describe("co-create quick entry integration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("场景编排设定 → 共创列表 → 文档场景 + 项目文件引用可编排标准输出", () => {
    const remoteRows: ScenarioApiRow[] = [
      {
        id: "tech-speech",
        code: "tech-speech",
        name: "输出技术发布稿",
        description: "基于项目资料撰写发布稿",
        status: "published",
        version: "1.0.0",
      },
      {
        id: "benchmark",
        code: "benchmark",
        name: "竞品对标",
        description: "生成对标分析表",
        status: "published",
        version: "1.0.0",
      },
    ];

    toggleCoCreateQuickScenario(SCOPE, "tech-speech");
    toggleCoCreateQuickScenario(SCOPE, "benchmark");

    const globalPrefs = { scenarioIds: ["tech-speech", "benchmark"] };
    saveCoCreateQuickScenariosPrefs(SCOPE, globalPrefs);

    const listItems = remoteRows.map((row) => ({
      ...scenarioFromRemoteRow(row),
      remote: row,
      isLocalTemplate: false,
    }));

    const entries = buildCoCreateQuickEntries(listItems, {
      globalQuickPrefs: globalPrefs,
    });

    expect(entries.map((e) => e.title)).toEqual(["输出技术发布稿", "竞品对标"]);

    const draftPlan = buildCoCreateQuickStartPlan({
      entry: entries[0]!,
      scenarioDetail: {
        goal: "撰写一版技术发布稿",
        preset_instructions: "参考项目附件与已有输出，形成可沉淀的标准文稿。",
      },
      agentMode: "agent",
      pinnedFileCount: 1,
      roundFileCount: 0,
    });
    expect(draftPlan.shouldTryAutoCreateDraft).toBe(true);
    expect(draftPlan.scenarioPresetInstructionsAppend).toContain("【文稿同步】");

    const patchPlan = buildCoCreateQuickStartPlan({
      entry: entries[0]!,
      scenarioDetail: {
        goal: "润色并补充当前方案文档",
        preset_instructions: "在引用文件基础上完善发布稿。",
      },
      agentMode: "agent",
      pinnedFileCount: 0,
      roundFileCount: 1,
    });
    expect(patchPlan.shouldTryAutoPatch).toBe(true);
    expect(patchPlan.scenarioPresetInstructionsAppend).toContain("【改写同步】");
  });
});
