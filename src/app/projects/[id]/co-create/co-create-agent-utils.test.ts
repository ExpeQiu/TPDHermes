import { describe, expect, it } from "vitest";

import {
  buildAgentModeInstructions,
  inferFileRecommendations,
  isPlanConfirmPrompt,
  parseAgentPlanFromContent,
  resolveExecutionFromAgentMode,
  stripAgentPlanBlock,
} from "./co-create-agent-utils";

describe("co-create-agent-utils", () => {
  it("buildAgentModeInstructions 为 ask 模式禁止写文件", () => {
    expect(buildAgentModeInstructions("ask")).toContain("禁止调用 write_file");
    expect(buildAgentModeInstructions("ask")).toContain("tavily_search");
    expect(buildAgentModeInstructions("ask")).toContain("公共真源库");
    expect(buildAgentModeInstructions("agent")).toContain("/附件/");
    expect(buildAgentModeInstructions("agent")).toContain("/输出/");
  });

  it("buildAgentModeInstructions plan 规划阶段含 skill 与 tphermes_plan", () => {
    const planning = buildAgentModeInstructions("plan", {
      planPhase: "planning",
      availableSkills: ["tech_trend_skill", "video_script_skill"],
    });
    expect(planning).toContain("tphermes_plan");
    expect(planning).toContain("tech_trend_skill");
    expect(planning).toContain("禁止 write_file");
  });

  it("buildAgentModeInstructions plan 执行阶段含已确认计划", () => {
    const executing = buildAgentModeInstructions("plan", {
      planPhase: "executing",
      confirmedPlan: {
        title: "发布稿",
        steps: [{ id: "1", title: "检索", skill: "tech_trend_skill" }],
      },
    });
    expect(executing).toContain("执行阶段");
    expect(executing).toContain("tech_trend_skill");
    expect(executing).toContain("workshop_generate");
  });

  it("isPlanConfirmPrompt 识别确认语", () => {
    expect(isPlanConfirmPrompt("开始执行")).toBe(true);
    expect(isPlanConfirmPrompt("确认计划")).toBe(true);
    expect(isPlanConfirmPrompt("请改成三段式")).toBe(false);
  });

  it("resolveExecutionFromAgentMode ask 保持编排", () => {
    const result = resolveExecutionFromAgentMode("ask", "fast");
    expect(result.useOrchestration).toBe(true);
    expect(result.allowFileWrites).toBe(false);
    expect(result.effectivePipeline).toBe("co_create");
  });

  it("parseAgentPlanFromContent 解析 tphermes_plan 块含 skill", () => {
    const content = `先给计划：

\`\`\`tphermes_plan
{"title":"发布稿","steps":[{"id":"1","title":"检索资料","skill":"tech_trend_skill"},{"id":"2","title":"起草正文"}]}
\`\`\`

正文开始。`;
    const plan = parseAgentPlanFromContent(content);
    expect(plan?.title).toBe("发布稿");
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0]?.skill).toBe("tech_trend_skill");
    expect(stripAgentPlanBlock(content)).not.toContain("tphermes_plan");
  });

  it("inferFileRecommendations 按关键词推荐文件", () => {
    const recs = inferFileRecommendations(
      "请改写技术发布稿亮点部分",
      [
        {
          id: "o1",
          kind: "output",
          title: "技术发布稿.md",
          path: "/输出/技术发布稿.md",
        },
        {
          id: "o2",
          kind: "output",
          title: "竞品分析.md",
          path: "/输出/竞品分析.md",
        },
      ],
      new Set(),
    );
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]?.fileName).toContain("技术发布稿");
  });
});
