import { describe, expect, it } from "vitest";

import {
  buildCoCreateQuickStartPlan,
  buildQuickStartScenarioContractInstructions,
  resolveCoCreateQuickStartPreset,
  resolveCoCreateQuickStartPrompt,
} from "@/app/projects/[id]/co-create/co-create-quick-start";
import type { CoCreateQuickEntry } from "@/lib/co-create-quick-entries";

function mockQuickEntry(overrides?: Partial<CoCreateQuickEntry>): CoCreateQuickEntry {
  return {
    id: "benchmark",
    scenarioId: "benchmark",
    title: "竞品对标",
    prompt: "请基于当前项目上下文，生成竞品对标分析表。",
    presetInstructions: "你是竞品分析专家，输出结构化对标表。",
    accent: "from-amber-600 to-orange-600",
    ...overrides,
  };
}

describe("co-create-quick-start", () => {
  it("优先使用场景详情中的 goal 与 preset_instructions", () => {
    const entry = mockQuickEntry();
    expect(
      resolveCoCreateQuickStartPrompt(entry, {
        goal: "输出一版技术发布稿",
        preset_instructions: "按发布会稿结构撰写。",
      }),
    ).toBe("请基于当前项目上下文，输出一版技术发布稿");
    expect(
      resolveCoCreateQuickStartPreset(entry, {
        goal: null,
        preset_instructions: "按发布会稿结构撰写。",
      }),
    ).toBe("按发布会稿结构撰写。");
  });

  it("无场景详情时回退到快捷入口缓存", () => {
    const entry = mockQuickEntry();
    expect(resolveCoCreateQuickStartPrompt(entry, null)).toBe(entry.prompt);
    expect(resolveCoCreateQuickStartPreset(entry, null)).toBe(entry.presetInstructions);
  });

  it("文档类快捷入口注入标准输出物 file_actions 指令", () => {
    const entry = mockQuickEntry({
      id: "tech-speech",
      scenarioId: "tech-speech",
      title: "输出技术发布稿",
      prompt: "请基于当前项目上下文，输出一版技术发布稿。",
    });

    const plan = buildCoCreateQuickStartPlan({
      entry,
      scenarioDetail: {
        goal: "撰写一版可用于对外发布的技术发布稿",
        preset_instructions: "含标题、导语、技术亮点与用户价值。",
      },
      agentMode: "agent",
      pinnedFileCount: 0,
      roundFileCount: 0,
    });

    expect(plan.scenarioId).toBe("tech-speech");
    expect(plan.scenarioPresetInstructions).toContain("技术亮点");
    expect(plan.scenarioPresetInstructionsAppend).toContain("【文稿同步】");
    expect(plan.scenarioPresetInstructionsAppend).toContain("【快捷创作·项目场景输出】");
    expect(plan.shouldTryAutoCreateDraft).toBe(true);
    expect(plan.shouldTryAutoPatch).toBe(false);
  });

  it("引用项目文件且为改写意图时注入改写同步指令", () => {
    const entry = mockQuickEntry({
      title: "润色当前方案",
      prompt: "请基于当前项目上下文，润色并补充方案文档亮点。",
    });

    const plan = buildCoCreateQuickStartPlan({
      entry,
      agentMode: "agent",
      pinnedFileCount: 1,
      roundFileCount: 1,
    });

    expect(plan.scenarioPresetInstructionsAppend).toContain("【改写同步】");
    expect(plan.shouldTryAutoPatch).toBe(true);
    expect(plan.useOrchestration).toBe(true);
  });

  it("场景合同指令包含必填章节", () => {
    const text = buildQuickStartScenarioContractInstructions(
      "技术方案说明",
      "请输出技术方案说明",
      {
        goal: "输出一版技术方案说明",
        preset_instructions: null,
        output_policy: {
          required_sections: ["背景", "方案设计", "优势"],
          must_follow_template: true,
        },
      },
    );
    expect(text).toContain("【快捷创作·项目场景输出】");
    expect(text).toContain("背景、方案设计、优势");
  });

  it("对标类场景走共创编排且保留场景预设", () => {
    const entry = mockQuickEntry();

    const plan = buildCoCreateQuickStartPlan({
      entry,
      agentMode: "agent",
      pinnedFileCount: 0,
      roundFileCount: 0,
    });

    expect(plan.prompt).toContain("竞品对标");
    expect(plan.scenarioPresetInstructions).toContain("竞品分析");
    expect(plan.skipTools).toBe(false);
  });

  it("技术方案说明类快捷入口在 agent 模式下始终尝试自动建稿", () => {
    const entry = mockQuickEntry({
      id: "tech-doc",
      scenarioId: "tech-doc",
      title: "技术方案说明",
      prompt: "请基于当前项目上下文，输出一版可用于外部沟通的技术方案说明。",
    });

    const plan = buildCoCreateQuickStartPlan({
      entry,
      agentMode: "agent",
      pinnedFileCount: 0,
      roundFileCount: 0,
    });

    expect(plan.outputEntryTitle).toBe("技术方案说明");
    expect(plan.shouldTryAutoCreateDraft).toBe(true);
    expect(plan.scenarioPresetInstructionsAppend).toContain("/输出/技术方案说明.md");
  });

  it("快捷创作在 agent 模式下强制走编排（项目+场景）", () => {
    const entry = mockQuickEntry({
      prompt: "你好",
    });
    const plan = buildCoCreateQuickStartPlan({
      entry,
      agentMode: "agent",
      pinnedFileCount: 0,
      roundFileCount: 0,
    });
    expect(plan.useOrchestration).toBe(true);
    expect(plan.skipTools).toBe(false);
  });
});
