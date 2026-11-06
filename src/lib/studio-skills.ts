import catalog from "../../shared/studio-skills.json";

/** 专业工作区技能卡。目录与 TPCstore V01–V21 对齐，只有 V04 已接入当前工作区。 */

export type StudioSkill = {
  id: string;
  name: string;
  sceneId: string;
  scene: string;
  phase: "P0" | "P1" | "P2" | "R";
  status: "ready" | "planned" | "local_app";
};

export const STUDIO_SCENES = [
  "洞察研究",
  "技术挖掘",
  "技术品牌与 IP",
  "认证策划",
  "传播与活动",
  "稿件与发言",
  "多模态与展具",
] as const;

export const STUDIO_SKILLS = catalog as StudioSkill[];

/** 未单独保存时，只有已接入工作区的卡片对用户开放。 */
export function defaultStudioSkillReleased(skill: StudioSkill): boolean {
  return skill.status === "ready";
}

export function isStudioSkillReleased(
  skill: StudioSkill,
  released: Readonly<Record<string, boolean>> | null,
): boolean {
  if (released && Object.prototype.hasOwnProperty.call(released, skill.id)) {
    return Boolean(released[skill.id]);
  }
  return defaultStudioSkillReleased(skill);
}

export function studioSkillById(id: string): StudioSkill {
  return STUDIO_SKILLS.find((skill) => skill.id === id) ?? STUDIO_SKILLS[3];
}

export function studioSkillStatusLabel(skill: StudioSkill): string {
  if (skill.status === "ready") return "可验证";
  if (skill.status === "local_app") return "已有应用";
  return "规划";
}
