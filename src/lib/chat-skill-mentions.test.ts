import { describe, expect, it } from "vitest";

import {
  chatSkillOptions,
  extractMentionedSkillNames,
  filterSkillMentions,
  skillMentionToken,
} from "@/lib/chat-skill-mentions";

const skills = chatSkillOptions(
  ["tech_pr_skill", "hello_skill"],
  [
    {
      name: "tech_pr_skill",
      display_name: "IP技术传播稿",
      when: "写传播稿",
      triggers: ["新闻稿"],
    },
    { name: "hello_skill", description: "打个招呼" },
  ],
);

describe("chat skill mentions", () => {
  it("用展示名和技能标识解析 @", () => {
    expect(extractMentionedSkillNames("请 @IP技术传播稿 写一版", skills)).toEqual([
      "tech_pr_skill",
    ]);
    expect(extractMentionedSkillNames("@hello_skill 你好", skills)).toEqual(["hello_skill"]);
    expect(extractMentionedSkillNames("没有技能", skills)).toEqual([]);
  });

  it("按名称、展示名和适用说明过滤", () => {
    expect(filterSkillMentions(skills, "传播").map((item) => item.name)).toEqual([
      "tech_pr_skill",
    ]);
    expect(filterSkillMentions(skills, "新闻").map((item) => item.name)).toEqual([
      "tech_pr_skill",
    ]);
    expect(filterSkillMentions(skills, "").map((item) => item.name)).toEqual([
      "tech_pr_skill",
      "hello_skill",
    ]);
  });

  it("展示名含空格时标记退回技能标识", () => {
    const spaced = chatSkillOptions(["pack skill"], [{ name: "pack skill", display_name: "包装 全案" }]);
    expect(skillMentionToken(spaced[0]!)).toBe("pack skill");
    expect(extractMentionedSkillNames("@pack 之后", spaced)).toEqual([]);
  });
});
