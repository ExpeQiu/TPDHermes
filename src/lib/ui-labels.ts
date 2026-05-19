/**
 * 前端展示用中文标签：将 API 字段名、状态枚举、入口标识等映射为可读中文。
 * 请求体字段名仍使用英文，仅 UI 展示层调用本模块。
 */

export function stepLabel(n: number): string {
  return `步骤 ${n}`;
}

export function stepRangeLabel(start: number, end: number): string {
  return `步骤 ${start}–${end}`;
}

const FIELD_LABELS: Record<string, string> = {
  entrypoint: "入口",
  project_id: "项目 ID",
  project_name: "项目名称",
  scenario_id: "场景 ID",
  source_output_id: "来源输出 ID",
  source_material: "来源素材",
  task_input: "任务输入",
  user_message: "用户消息",
  overrides: "覆盖参数",
  "overrides.skills": "技能覆盖",
  doc_id: "文档 ID",
  source_type: "来源类型",
  conversation_id: "会话 ID",
  confidence: "置信度",
  collection: "知识集合",
  linked_kg_ids: "关联图谱 ID",
  rel_type: "关系类型",
  src_kind: "源实体类型",
  src_id: "源实体 ID",
  dst_kind: "目标实体类型",
  dst_id: "目标实体 ID",
  folder_path: "目录路径",
  domain: "业务域",
  project_ids: "关联项目",
  harvested_from_user_confirmed: "用户已确认收割",
  upload_id: "上传 ID",
  template_id: "输出模版 ID",
  run_id: "执行 ID",
  output_id: "输出 ID",
  code: "场景编码",
  skill: "技能",
  extra: "附加要求",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

const SCENARIO_STATUS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
  disabled: "已停用",
};

export function scenarioStatusLabel(status: string | null | undefined): string {
  if (!status) return "草稿";
  const k = status.toLowerCase();
  return SCENARIO_STATUS[k] ?? status;
}

const PROJECT_STATUS: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

export function projectStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const k = status.toLowerCase();
  return PROJECT_STATUS[k] ?? status;
}

const OUTPUT_STATUS: Record<string, string> = {
  draft: "草稿",
  completed: "已完成",
  approved: "已批准",
  archived: "已归档",
};

export function outputStatusLabel(status: string | null | undefined): string {
  if (!status) return "草稿";
  const k = status.toLowerCase();
  return OUTPUT_STATUS[k] ?? status;
}

const RUN_STATUS: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  error: "错误",
};

export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  const k = status.toLowerCase();
  return RUN_STATUS[k] ?? status;
}

const ENTRYPOINT: Record<string, string> = {
  workshop: "结果工坊",
  chat: "编排协作",
  create: "场景编排",
  quick_create: "快速创建",
  project: "项目中心",
};

export function entrypointLabel(entrypoint: string | null | undefined): string {
  if (!entrypoint) return "—";
  const k = entrypoint.toLowerCase();
  return ENTRYPOINT[k] ?? entrypoint;
}

export function workshopModeLabel(mode: "refine" | "generate"): string {
  return mode === "refine" ? "结果优化" : "定向生成";
}

export function skillsOverrideSummary(skillRun: string): string {
  if (!skillRun) return "需在场景编排中绑定技能";
  return `指定技能执行，白名单 [${skillRun}]，不允许智能体自由切换`;
}

export const POLICY_SECTION_SUMMARY = "知识策略 / 技能策略 / 输出策略";

export const TASK_EXECUTE_HINT =
  "与点击「开始生成」时调用的任务执行接口字段一致（项目、场景、任务输入、用户消息、覆盖参数）";

export function taskInputSectionTitle(): string {
  return "任务输入（JSON）";
}

export function userMessageSectionTitle(): string {
  return "用户消息（JSON）";
}

const KG_KIND_LABELS: Record<string, string> = {
  Brand: "品牌",
  Vehicle: "车型",
  TechInsight: "技术洞察",
  CoreTech: "核心技术",
  PlannedVehicle: "规划车型",
};

export function kgKindLabel(kind: string): string {
  return KG_KIND_LABELS[kind] ?? kind;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  conversation_harvest: "对话收割",
  file: "文件",
  upload: "上传",
};

export function kbSourceTypeLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "—";
  return SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

export function skillScopeLabel(scope: string | null | undefined): string {
  if (scope === "personal") return "个人";
  if (scope === "public") return "公共";
  return scope ? scope : "公共";
}

/** 编排协作页：传输链路展示 */
export function chatTransportLabel(opts: {
  useOrchestration: boolean;
  proxyMode?: string;
}): string {
  if (opts.useOrchestration) return "统一任务执行";
  if (opts.proxyMode === "backend-proxy") return "后端代理";
  return "自定义地址";
}
