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

export const STUDIO_SKILLS: StudioSkill[] = [
  { id: "V01", name: "趋势与竞品证据对照器", sceneId: "01", scene: "洞察研究", phase: "P1", status: "planned" },
  { id: "V02", name: "调研方案与样本配置器", sceneId: "01", scene: "洞察研究", phase: "P2", status: "planned" },
  { id: "V03", name: "用户旅程与机会图", sceneId: "01", scene: "洞察研究", phase: "P1", status: "planned" },
  { id: "V04", name: "技术卡提取与核对器", sceneId: "02", scene: "技术挖掘", phase: "P0", status: "ready" },
  { id: "V05", name: "技术价值链编辑器", sceneId: "02", scene: "技术挖掘", phase: "P0", status: "planned" },
  { id: "V06", name: "技术品牌命名比较器", sceneId: "03", scene: "技术品牌与 IP", phase: "P1", status: "planned" },
  { id: "V07", name: "核心信息屋编辑器", sceneId: "03", scene: "技术品牌与 IP", phase: "P0", status: "planned" },
  { id: "V08", name: "IP 货架与车型适配器", sceneId: "03", scene: "技术品牌与 IP", phase: "P1", status: "planned" },
  { id: "V09", name: "技术—车型—品牌互锁排期器", sceneId: "03", scene: "技术品牌与 IP", phase: "P1", status: "planned" },
  { id: "V10", name: "主张与证据匹配器", sceneId: "04", scene: "认证策划", phase: "P0", status: "planned" },
  { id: "V11", name: "验证方案与报价试算器", sceneId: "04", scene: "认证策划", phase: "P1", status: "planned" },
  { id: "V12", name: "传播内容与节奏规划器", sceneId: "05", scene: "传播与活动", phase: "P1", status: "planned" },
  { id: "V13", name: "活动流程与物料编排器", sceneId: "05", scene: "传播与活动", phase: "P0", status: "planned" },
  { id: "V14", name: "SpeechStudio 演绎与彩排", sceneId: "05", scene: "传播与活动", phase: "R", status: "local_app" },
  { id: "V15", name: "稿件编写与审校台", sceneId: "06", scene: "稿件与发言", phase: "P0", status: "planned" },
  { id: "V16", name: "采访问答演练器", sceneId: "06", scene: "稿件与发言", phase: "P2", status: "planned" },
  { id: "V17", name: "CutPot 视频制作", sceneId: "07", scene: "多模态与展具", phase: "R", status: "local_app" },
  { id: "V18", name: "FrameFlow 局部返修", sceneId: "07", scene: "多模态与展具", phase: "R", status: "local_app" },
  { id: "V19", name: "展具体验路径设计器", sceneId: "07", scene: "多模态与展具", phase: "P1", status: "planned" },
  { id: "V20", name: "展具立项与制作配置器", sceneId: "07", scene: "多模态与展具", phase: "P1", status: "planned" },
  { id: "V21", name: "展具安装与运维点检器", sceneId: "07", scene: "多模态与展具", phase: "P2", status: "planned" },
];

export function studioSkillById(id: string): StudioSkill {
  return STUDIO_SKILLS.find((skill) => skill.id === id) ?? STUDIO_SKILLS[3];
}

export function studioSkillStatusLabel(skill: StudioSkill): string {
  if (skill.status === "ready") return "可验证";
  if (skill.status === "local_app") return "已有应用";
  return "规划";
}
