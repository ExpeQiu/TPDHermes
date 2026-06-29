import { describe, expect, it } from "vitest";

import { unwrapSkillAssistantMarkdown } from "@/lib/skill-output";

describe("unwrapSkillAssistantMarkdown", () => {
  it("从技能 JSON 信封提取 content", () => {
    const raw = JSON.stringify({
      skill: "tech_trend_skill",
      content: "# 技术方向趋势研判\n\n## 技术现状\n正文",
      context: {},
    });
    expect(unwrapSkillAssistantMarkdown(raw)).toBe(
      "# 技术方向趋势研判\n\n## 技术现状\n正文",
    );
  });

  it("非 JSON 原文透传", () => {
    expect(unwrapSkillAssistantMarkdown("普通回复")).toBe("普通回复");
  });
});
