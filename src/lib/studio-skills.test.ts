import { describe, expect, it } from "vitest";

import { STUDIO_SKILLS, isStudioSkillReleased, studioSkillStatusLabel } from "./studio-skills";

describe("studio skills", () => {
  it("lists the 21 planned skills and only V04 is ready", () => {
    expect(STUDIO_SKILLS).toHaveLength(21);
    expect(new Set(STUDIO_SKILLS.map((skill) => skill.id)).size).toBe(21);
    expect(STUDIO_SKILLS.filter((skill) => skill.status === "ready").map((skill) => skill.id)).toEqual(["V04"]);
    expect(studioSkillStatusLabel(STUDIO_SKILLS[0])).toBe("规划");
    expect(studioSkillStatusLabel(STUDIO_SKILLS.find((skill) => skill.id === "V17")!)).toBe("已有应用");
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