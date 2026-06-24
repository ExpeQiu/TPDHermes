import { describe, expect, it } from "vitest";

import {
  buildAgentModeInstructions,
  inferFileRecommendations,
  parseAgentPlanFromContent,
  resolveExecutionFromAgentMode,
  stripAgentPlanBlock,
} from "./co-create-agent-utils";

describe("co-create-agent-utils", () => {
  it("buildAgentModeInstructions 为 ask 模式禁止写文件", () => {
    expect(buildAgentModeInstructions("ask")).toContain("禁止调用 write_file");
    expect(buildAgentModeInstructions("agent")).toBe("");
    expect(buildAgentModeInstructions("plan")).toContain("tphermes_plan");
  });

  it("resolveExecutionFromAgentMode ask 保持编排", () => {
    const result = resolveExecutionFromAgentMode("ask", "fast");
    expect(result.useOrchestration).toBe(true);
    expect(result.allowFileWrites).toBe(false);
    expect(result.effectivePipeline).toBe("co_create");
  });

  it("parseAgentPlanFromContent 解析 tphermes_plan 块", () => {
    const content = `先给计划：

\`\`\`tphermes_plan
{"title":"发布稿","steps":[{"id":"1","title":"检索资料"},{"id":"2","title":"起草正文"}]}
\`\`\`

正文开始。`;
    const plan = parseAgentPlanFromContent(content);
    expect(plan?.title).toBe("发布稿");
    expect(plan?.steps).toHaveLength(2);
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
