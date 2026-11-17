import { describe, expect, it } from "vitest";

import { STUDIO_SKILLS, isStudioSkillReleased, studioSkillStatusLabel } from "./studio-skills";

describe("studio skills", () => {
  it("lists the 22 skills and releases the ready cards", () => {
    expect(STUDIO_SKILLS).toHaveLength(22);
    expect(new Set(STUDIO_SKILLS.map((skill) => skill.id)).size).toBe(22);
    expect(STUDIO_SKILLS.filter((skill) => skill.status === "ready").map((skill) => skill.id)).toEqual(["V04", "V05", "V10", "V17"]);
    expect(studioSkillStatusLabel(STUDIO_SKILLS[0])).toBe("规划");
    expect(studioSkillStatusLabel(STUDIO_SKILLS.find((skill) => skill.id === "V14")!)).toBe("已有应用");
    expect(studioSkillStatusLabel(STUDIO_SKILLS.find((skill) => skill.id === "V17")!)).toBe("可验证");
    expect(studioSkillStatusLabel(STUDIO_SKILLS.find((skill) => skill.id === "V22")!)).toBe("已有应用");
  });

  it("keeps unreleased cards closed until an admin opens them", () => {
    const planned = STUDIO_SKILLS[0];
    const ready = STUDIO_SKILLS.find((skill) => skill.id === "V04")!;
    expect(isStudioSkillReleased(planned, null)).toBe(false);
    expect(isStudioSkillReleased(ready, null)).toBe(true);
    expect(isStudioSkillReleased(planned, { V01: true })).toBe(true);
    expect(isStudioSkillReleased(ready, { V04: false })).toBe(false);
  });
});