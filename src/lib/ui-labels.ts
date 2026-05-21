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
  approved: "已采纳",
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
  project_output: "项目输出",
  project_attachment: "项目附件",
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

const SKILL_LABELS: Record<string, string> = {
  hello_skill: "Hello 示例",
  speech_skill: "发言稿",
  video_skill: "视频脚本",
  a4_skill: "A4 一页纸",
  benchmark_skill: "竞品对标分析",
  ip_matrix_skill: "IP 矩阵图",
  knowledge_harvest_draft: "知识收割草稿",
  sales_skill: "销售话术手册",
  material_skill: "传播素材清单",
};

/** 技能展示名：优先 skill.json / metadata 的 display_name，否则内置中文映射 */
export function skillLabel(name: string, displayName?: string | null): string {
  const fromMeta = displayName?.trim();
  if (fromMeta && fromMeta !== name) return fromMeta;
  return SKILL_LABELS[name] ?? fromMeta ?? name;
}

const KB_SCOPE_LABELS: Record<string, string> = {
  public: "公共",
  internal: "内部",
  project: "项目",
};

export const KB_DOMAIN_LABELS: Record<string, string> = {
  public_intel: "公开情报",
  structured_tech: "结构化技术",
  release_assets: "发布素材",
  market_research: "市场研究",
  policy_regulation: "政策法规",
  internal_methodology: "内部方法论",
  _uncategorized: "未设置业务域",
};

/** metadata.domain → 中文业务域名 */
export function kbDomainLabel(domain: string | undefined | null): string {
  const k = (domain ?? "").trim();
  if (!k) return "未分类";
  return KB_DOMAIN_LABELS[k] ?? humanizeKbSegment(k);
}

const KB_TOPIC_LABELS: Record<string, string> = {
  speeches: "发言稿",
  geely_tech: "吉利技术",
  vehicle_launch: "车型发布",
  autonomous_driving: "自动驾驶",
  remote_debug: "远程联调",
  competitor_news: "竞品资讯",
  pitch_materials: "路演材料",
  process_docs: "流程文档",
  auto_company_strategy: "车企战略",
  auto_company_strategy_local_smoke: "车企战略（联调）",
  vehicle_model_library: "车型库",
};

function humanizeKbSegment(seg: string): string {
  const k = seg.trim();
  if (!k) return "";
  return KB_TOPIC_LABELS[k] ?? k.replace(/_/g, " ");
}

/** 知识库 collection 展示名（规范名 → 中文可读标签） */
export function kbCollectionLabel(
  name: string,
  opts?: { projectNames?: Record<string, string> },
): string {
  const key = name.trim();
  if (!key) return "—";

  const projectKbMatch = /^project\.([^.]+)\.kb$/.exec(key);
  if (projectKbMatch) {
    const pid = projectKbMatch[1];
    const pname = opts?.projectNames?.[pid]?.trim();
    return pname ? `${pname} · 项目知识库` : "项目知识库";
  }

  const parts = key.split(".").filter(Boolean);
  if (parts.length >= 3) {
    const [scope, domain, ...rest] = parts;
    const domainLabel = KB_DOMAIN_LABELS[domain] ?? humanizeKbSegment(domain);
    const topicLabel = rest.map(humanizeKbSegment).filter(Boolean).join(" · ");
    if (scope === "public") {
      return topicLabel ? `${domainLabel} · ${topicLabel}` : domainLabel;
    }
    const scopeLabel = KB_SCOPE_LABELS[scope] ?? scope;
    return topicLabel
      ? `${scopeLabel} · ${domainLabel} · ${topicLabel}`
      : `${scopeLabel} · ${domainLabel}`;
  }

  if (parts.length === 2) {
    const [scope, domain] = parts;
    const domainLabel = KB_DOMAIN_LABELS[domain] ?? humanizeKbSegment(domain);
    if (scope === "public") return domainLabel;
    const scopeLabel = KB_SCOPE_LABELS[scope] ?? scope;
    return `${scopeLabel} · ${domainLabel}`;
  }

  return key;
}

/** 是否为公共知识库 collection（与 /knowledge 目录树对应，排除 project.*.kb 等） */
export function isPublicKbCollection(name: string): boolean {
  return name.trim().startsWith("public.");
}

export function filterPublicKbCollections(collections: string[]): string[] {
  return collections.filter(isPublicKbCollection);
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
