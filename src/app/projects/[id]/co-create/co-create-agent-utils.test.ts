import { describe, expect, it } from "vitest";

import {
  buildAgentModeInstructions,
  inferFileRecommendations,
  isPlanConfirmPrompt,
  roomPlanReady,
  parseAgentPlanFromContent,
  planContractFromPlan,
  resolveExecutionFromAgentMode,
  stripAgentPlanBlock,
} from "./co-create-agent-utils";

describe("co-create-agent-utils", () => {
  it("没有计划版本时不能确认执行", () => {
    expect(roomPlanReady(0)).toBe(false);
    expect(roomPlanReady(undefined)).toBe(false);
    expect(roomPlanReady(1)).toBe(true);
    expect(isPlanConfirmPrompt("开始执行")).toBe(true);
  });

  it("buildAgentModeInstructions 为 ask 模式禁止写文件", () => {
    expect(buildAgentModeInstructions("ask")).toContain("禁止调用 write_file");
    expect(buildAgentModeInstructions("ask")).toContain("tavily_search");
    expect(buildAgentModeInstructions("ask")).toContain("公共真源库");
    expect(buildAgentModeInstructions("agent")).toContain("/附件/");
    expect(buildAgentModeInstructions("agent")).toContain("/输出/");
  });

  it("buildAgentModeInstructions plan 规划阶段含 skill 与 TPCharness_plan", () => {
    const planning = buildAgentModeInstructions("plan", {
      planPhase: "planning",
      availableSkills: ["tech_trend_skill", "video_script_skill"],
    });
    expect(planning).toContain("TPCharness_plan");
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

  it("计划内容变化后确认版本不再相同", () => {
    const first = planContractFromPlan({
      title: "发布稿",
      steps: [{ id: "1", title: "检索" }],
    });
    const revised = planContractFromPlan({
      title: "发布稿",
      steps: [{ id: "1", title: "改成三段" }],
    });
    expect(first.planVersion).not.toBe(revised.planVersion);
    expect(first.planId).toBe(`plan-${first.planVersion}`);
  });

  it("有文件上下文时不走快速路径", () => {
    const withFiles = resolveExecutionFromAgentMode("agent", "fast", { hasFileContext: true });
    expect(withFiles.useOrchestration).toBe(true);
    expect(withFiles.skipTools).toBe(false);
    const greeting = resolveExecutionFromAgentMode("agent", "fast");
    expect(greeting.useOrchestration).toBe(false);
    const planning = resolveExecutionFromAgentMode("plan", "fast", { planPhase: "awaiting_confirm" });
    expect(planning.allowFileWrites).toBe(false);
    const executing = resolveExecutionFromAgentMode("plan", "research", { planPhase: "executing" });
    expect(executing.allowFileWrites).toBe(true);
    expect(executing.useOrchestration).toBe(true);
  });

  it("resolveExecutionFromAgentMode ask 保持编排", () => {
    const result = resolveExecutionFromAgentMode("ask", "fast");
    expect(result.useOrchestration).toBe(true);
    expect(result.allowFileWrites).toBe(false);
    expect(result.effectivePipeline).toBe("co_create");
  });

  it("parseAgentPlanFromContent 解析 TPCharness_plan 块含 skill", () => {
    const content = `先给计划：

\`\`\`TPCharness_plan
{"title":"发布稿","steps":[{"id":"1","title":"检索资料","skill":"tech_trend_skill"},{"id":"2","title":"起草正文"}]}
\`\`\`

正文开始。`;
    const plan = parseAgentPlanFromContent(content);
    expect(plan?.title).toBe("发布稿");
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[0]?.skill).toBe("tech_trend_skill");
    expect(stripAgentPlanBlock(content)).not.toContain("TPCharness_plan");
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
          file_type: "md",
        },
        {
          id: "o2",
          kind: "output",
          title: "竞品分析.md",
          path: "/输出/竞品分析.md",
          file_type: "md",
        },
      ],
      new Set(),
    );
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]?.fileName).toContain("技术发布稿");
  });
});
