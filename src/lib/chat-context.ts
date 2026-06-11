import { apiFetch, apiGet, readJson, apiV1 } from "@/lib/api";
import { getApiHeaders } from "@/lib/api-headers";

export type QuickCreateOutputPreset = "markdown" | "plain" | "structured";

/** /chat 场景二分：共创自由对话 vs 文稿优化（须项目+输出物） */
export type ChatMode = "co_create" | "doc_optimize";

export type ProjectFileKind = "output" | "attachment";

/** 项目文件列表项（附件 + 输出物统一展示） */
export interface ProjectFileListItem {
  id: string;
  kind: ProjectFileKind;
  title: string;
  summary?: string | null;
  created_at?: string | null;
  status?: string | null;
}

/** 前端下拉 value：`output:{id}` | `attachment:{id}` | `__all__`（全部输出物与附件） */
export const ALL_PROJECT_FILES_SELECT_VALUE = "__all__";

export function isAllProjectFilesSelection(value: string): boolean {
  return value.trim() === ALL_PROJECT_FILES_SELECT_VALUE;
}

export function encodeProjectFileSelectValue(kind: ProjectFileKind, id: string): string {
  return `${kind}:${id}`;
}

export function decodeProjectFileSelectValue(
  value: string,
): { kind: ProjectFileKind; id: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(":");
  if (idx <= 0) return null;
  const kind = trimmed.slice(0, idx) as ProjectFileKind;
  const id = trimmed.slice(idx + 1);
  if ((kind !== "output" && kind !== "attachment") || !id) return null;
  return { kind, id };
}

/** 从 /create 带入、仅首条会话消费的编排覆盖（避免落盘 localStorage） */
export interface QuickCreateFlowOverrides {
  knowledgeCollections?: string[];
  skillNames?: string[];
  outputPreset?: QuickCreateOutputPreset;
  outputRequiredSections?: string[];
}

export interface ChatInit {
  scenarioId: string;
  systemContext: string;
  opener: string;
  timestamp: number;
  projectId?: string;
  projectName?: string;
  selectedCollection?: string;
  /** 多选知识库时与 selectedCollection（主集合）同时存在；检索侧暂用主集合 */
  knowledgeCollections?: string[];
  knowledgeEnabled?: boolean;
  skillsEnabled?: boolean;
  /** 勾选「携带技能」时允许带入的子集；空则回退为工坊全量列表 */
  selectedSkills?: string[];
  outputPreset?: QuickCreateOutputPreset;
  /** outputPreset=structured 时由创建页写入建议章节 */
  outputRequiredSections?: string[];
  entrySummary?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description?: string | null;
  background?: string | null;
  audience?: string | null;
  deadline?: string | null;
  constraints?: Record<string, unknown> | null;
  status: string;
  created_at?: string;
  updated_at?: string;
}

interface KbQueryItem {
  content?: string;
  metadata?: Record<string, unknown>;
  distance?: number;
  id?: string;
}

interface KbQueryResponse {
  results: KbQueryItem[];
  source: string;
  count: number;
  warning?: string | null;
}

interface CollectionsResponse {
  collections: string[];
}

interface WorkshopSkillsResponse {
  skills: string[];
}

export interface ChatTransportConfig {
  mode: string;
  target: string;
  model: string;
}

export interface ContextBlock {
  tool: string;
  title: string;
  content: string;
}

export interface ChatBootstrapData {
  projects: ProjectRecord[];
  collections: string[];
  skills: string[];
  transport: ChatTransportConfig | null;
  warnings: string[];
}

export interface BuildContextOptions {
  query: string;
  projectId?: string;
  collectionName?: string;
  includeProject: boolean;
  includeKnowledge: boolean;
  includeSkills: boolean;
  skillSnapshot?: string[];
}

export interface BuildContextResult {
  toolsContext: string;
  blocks: ContextBlock[];
  warnings: string[];
}

function compactLines(lines: Array<string | null | undefined>): string {
  return lines.filter(Boolean).join("\n");
}

function trimText(value: string | null | undefined, max = 280): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatConstraints(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatProjectBlock(project: ProjectRecord): ContextBlock {
  return {
    tool: "mcp_tphermes_project_get",
    title: `项目上下文：${project.name}`,
    content: compactLines([
      `项目 ID: ${project.id}`,
      `状态: ${project.status}`,
      trimText(project.description) ? `描述: ${trimText(project.description)}` : null,
      trimText(project.background) ? `背景: ${trimText(project.background)}` : null,
      trimText(project.audience) ? `受众: ${trimText(project.audience, 160)}` : null,
      trimText(project.deadline, 120) ? `截止时间: ${trimText(project.deadline, 120)}` : null,
      formatConstraints(project.constraints) ? `约束: ${formatConstraints(project.constraints)}` : null,
    ]),
  };
}

function formatKbBlock(
  collectionName: string,
  result: KbQueryResponse,
): ContextBlock {
  const items = result.results.slice(0, 3).map((item, index) => {
    const title = trimText(
      typeof item.metadata?.title === "string"
        ? item.metadata.title
        : typeof item.metadata?.name === "string"
          ? item.metadata.name
          : typeof item.id === "string"
            ? item.id
            : "",
      80,
    );
    const snippet = trimText(item.content, 220) ?? "(无摘要)";
    const distance = typeof item.distance === "number" ? `，distance=${item.distance.toFixed(4)}` : "";
    return `${index + 1}. ${title ? `${title}: ` : ""}${snippet}${distance}`;
  });

  return {
    tool: "mcp_tphermes_kb_query",
    title: `知识库检索：${collectionName}`,
    content: compactLines([
      `集合: ${collectionName}`,
      `来源: ${result.source}`,
      `命中数: ${result.count}`,
      result.warning ? `警告: ${result.warning}` : null,
      items.length > 0 ? "结果:\n" + items.join("\n") : "结果: 未命中",
    ]),
  };
}

function formatSkillsBlock(skills: string[]): ContextBlock {
  const display = skills.slice(0, 12);
  return {
    tool: "mcp_tphermes_workshop_list_skills",
    title: "工坊技能快照",
    content: compactLines([
      `技能数: ${skills.length}`,
      `技能: ${display.join(", ") || "暂无"}`,
      skills.length > display.length ? `其余: 还有 ${skills.length - display.length} 个技能未展开` : null,
    ]),
  };
}

function renderToolsContext(blocks: ContextBlock[]): string {
  if (blocks.length === 0) return "";
  return [
    "[TPDHermes 显式上下文注入]",
    "以下内容来自发送前显式调用的 TPDHermes 能力，请作为回答时的参考上下文。",
    ...blocks.flatMap((block) => [
      "",
      `### ${block.tool}`,
      `标题: ${block.title}`,
      block.content,
    ]),
  ].join("\n");
}

export interface TaskExecuteOverrides {
  template_id?: string;
  knowledge?: { collections?: string[]; mode?: string; top_k?: number; project_bound?: boolean };
  skills?: {
    mode?: string;
    allowed?: string[];
    preferred?: string[];
    allow_agent_free_choice?: boolean;
  };
  output?: { template_id?: string; required_sections?: string[]; must_follow_template?: boolean };
}

export interface TaskInputPayload {
  title?: string | null;
  background?: string | null;
  objective?: string | null;
  source_material?: string | null;
  keywords?: string[] | string | null;
  tone?: string | null;
  extra?: string | null;
}

export interface LocalRewriteInput {
  targetSection?: string;
  sourceExcerpt?: string;
  rewriteGoal?: string;
}

export function hasLocalRewrite(input: LocalRewriteInput | undefined): boolean {
  if (!input) return false;
  return Boolean(
    input.targetSection?.trim() || input.sourceExcerpt?.trim() || input.rewriteGoal?.trim(),
  );
}

/** 文稿优化场景：结构化局部改写约束写入 task_input.extra */
export function formatLocalRewriteExtra(input: LocalRewriteInput): string {
  const lines: string[] = ["[局部改写约束]"];
  const section = input.targetSection?.trim();
  const excerpt = input.sourceExcerpt?.trim();
  const goal = input.rewriteGoal?.trim();
  if (section) lines.push(`目标章节/段落: ${section.slice(0, 400)}`);
  if (excerpt) lines.push(`原文片段: ${excerpt.slice(0, 1200)}`);
  if (goal) lines.push(`改写目标: ${goal.slice(0, 800)}`);
  lines.push("请仅修改指定范围，保留未提及部分的原意与结构。");
  return lines.join("\n");
}

/** 文稿优化：标明待优化输出与全文注入方式（非 kb 上下文） */
export function formatDocOptimizeTaskExtra(
  output: ProjectFileListItem,
  input: LocalRewriteInput,
): string {
  const parts = [
    "[文稿优化]",
    `待优化输出: output_id=${output.id} title=${output.title}`,
    "服务端已将上述输出的完整正文写入 task_input.source_material；请基于全文做局部优化，勿将其仅作参考上下文或依赖 kb 检索。",
  ];
  if (hasLocalRewrite(input)) {
    parts.push(formatLocalRewriteExtra(input));
  } else {
    parts.push("改写要求见本轮用户消息；请仅修改用户指明范围，保留其余部分原意与结构。");
  }
  return parts.join("\n\n");
}

export function formatAttachmentContextExtra(item: ProjectFileListItem): string {
  return [
    "[附件上下文]",
    `attachment_id=${item.id}`,
    `filename=${item.title}`,
    "请按需 kb_query 检索附件片段，勿臆造未检索内容。",
  ].join("\n");
}

export function formatAllProjectFilesExtra(files: ProjectFileListItem[]): string {
  const outputs = files.filter((f) => f.kind === "output");
  const attachments = files.filter((f) => f.kind === "attachment");
  if (outputs.length === 0 && attachments.length === 0) {
    return "";
  }
  const lines: string[] = ["[项目文件上下文]"];
  if (outputs.length > 0) {
    lines.push("输出物：");
    for (const item of outputs) {
      lines.push(`- output_id=${item.id} title=${item.title}`);
    }
  }
  if (attachments.length > 0) {
    lines.push("附件：");
    for (const item of attachments) {
      lines.push(`- attachment_id=${item.id} filename=${item.title}`);
    }
  }
  lines.push("请按需 kb_query 检索上述输出物与附件，勿臆造未检索内容。");
  return lines.join("\n");
}

export interface BuildChatTaskContextOptions {
  chatMode: ChatMode;
  includeProjectContext: boolean;
  includeFileContext: boolean;
  selectedProjectId: string;
  selectedFileValue: string;
  projectFiles: ProjectFileListItem[];
  projectContextExtra: string;
  localRewrite?: LocalRewriteInput;
}

export interface BuildChatTaskContextResult {
  sourceOutputId: string | null;
  taskInputExtra: string;
  error: string | null;
}

export function buildChatTaskContextPayload(
  options: BuildChatTaskContextOptions,
): BuildChatTaskContextResult {
  const parts: string[] = [];
  const decoded = options.selectedFileValue
    ? decodeProjectFileSelectValue(options.selectedFileValue)
    : null;
  const selectedFile = decoded
    ? options.projectFiles.find((f) => f.id === decoded.id && f.kind === decoded.kind)
    : null;

  if (options.chatMode === "doc_optimize") {
    if (!options.includeProjectContext || !options.selectedProjectId) {
      return { sourceOutputId: null, taskInputExtra: "", error: "文稿优化须选择项目" };
    }
    if (isAllProjectFilesSelection(options.selectedFileValue)) {
      return {
        sourceOutputId: null,
        taskInputExtra: "",
        error: "文稿优化须指定单篇输出物，不支持「全部文件」",
      };
    }
    if (!decoded || decoded.kind !== "output") {
      return {
        sourceOutputId: null,
        taskInputExtra: "",
        error: "文稿优化须选择待优化的项目输出物",
      };
    }
    if (!selectedFile) {
      return {
        sourceOutputId: null,
        taskInputExtra: "",
        error: "所选输出物不存在或已失效，请重新选择",
      };
    }
    parts.push(formatDocOptimizeTaskExtra(selectedFile, options.localRewrite ?? {}));
    return { sourceOutputId: decoded.id, taskInputExtra: parts.join("\n\n"), error: null };
  }

  // co_create
  const allProjectFiles =
    options.includeFileContext &&
    isAllProjectFilesSelection(options.selectedFileValue) &&
    options.projectFiles.length > 0;

  if (
    options.includeProjectContext &&
    options.selectedProjectId &&
    options.projectContextExtra.trim() &&
    (!options.includeFileContext || !decoded)
  ) {
    parts.push(options.projectContextExtra.trim());
  }
  if (allProjectFiles) {
    const block = formatAllProjectFilesExtra(options.projectFiles);
    if (block) parts.push(block);
  }
  if (options.includeFileContext && decoded?.kind === "output") {
    if (hasLocalRewrite(options.localRewrite)) {
      parts.push(formatLocalRewriteExtra(options.localRewrite ?? {}));
    }
    return { sourceOutputId: decoded.id, taskInputExtra: parts.join("\n\n"), error: null };
  }
  if (options.includeFileContext && decoded?.kind === "attachment" && selectedFile) {
    parts.push(formatAttachmentContextExtra(selectedFile));
    if (hasLocalRewrite(options.localRewrite)) {
      parts.push(formatLocalRewriteExtra(options.localRewrite ?? {}));
    }
    return { sourceOutputId: null, taskInputExtra: parts.join("\n\n"), error: null };
  }
  if (hasLocalRewrite(options.localRewrite)) {
    parts.push(formatLocalRewriteExtra(options.localRewrite ?? {}));
  }
  return { sourceOutputId: null, taskInputExtra: parts.join("\n\n"), error: null };
}

/** 文稿优化：检查项目与输出物是否已绑定，供侧栏与发送前提醒 */
export function getDocOptimizeBindingStatus(options: {
  selectedProjectId: string;
  selectedFileValue: string;
  projectFiles: ProjectFileListItem[];
  projectFilesLoading?: boolean;
}): { ready: boolean; issues: string[] } {
  const issues: string[] = [];
  const pid = options.selectedProjectId.trim();
  if (!pid) {
    issues.push("请选择项目");
    return { ready: false, issues };
  }
  if (options.projectFilesLoading) {
    issues.push("正在加载输出物列表…");
    return { ready: false, issues };
  }
  const outputs = options.projectFiles.filter((f) => f.kind === "output");
  if (outputs.length === 0) {
    issues.push("该项目暂无输出物，请先在项目中创建文稿");
  }
  const decoded = decodeProjectFileSelectValue(options.selectedFileValue);
  if (!decoded || decoded.kind !== "output") {
    issues.push("请选择待优化输出物");
  } else {
    const file = options.projectFiles.find((f) => f.id === decoded.id && f.kind === "output");
    if (!file) {
      issues.push("所选输出物不存在或已失效，请重新选择");
    }
  }
  return { ready: issues.length === 0, issues };
}

interface ProjectOutputListRow {
  id: string;
  title?: string | null;
  summary?: string | null;
  created_at?: string | null;
  status?: string | null;
}

interface ProjectAttachmentListRow {
  id: string;
  original_filename: string;
  created_at?: string | null;
  ingest_status?: string | null;
}

export async function fetchProjectFiles(projectId: string): Promise<ProjectFileListItem[]> {
  const [outputsRes, attachmentsRes] = await Promise.allSettled([
    apiGet<ProjectOutputListRow[]>(`/projects/${projectId}/outputs`),
    apiGet<ProjectAttachmentListRow[]>(`/projects/${projectId}/attachments`),
  ]);
  const files: ProjectFileListItem[] = [];
  if (outputsRes.status === "fulfilled") {
    for (const row of outputsRes.value) {
      files.push({
        id: row.id,
        kind: "output",
        title: (row.title?.trim() || "未命名输出").slice(0, 120),
        summary: row.summary,
        created_at: row.created_at,
        status: row.status,
      });
    }
  }
  if (attachmentsRes.status === "fulfilled") {
    for (const row of attachmentsRes.value) {
      files.push({
        id: row.id,
        kind: "attachment",
        title: row.original_filename.slice(0, 120),
        summary: row.ingest_status ? `索引: ${row.ingest_status}` : null,
        created_at: row.created_at,
      });
    }
  }
  files.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return files;
}

export interface TaskExecuteBody {
  /** 标准入口：任务与编排请求均使用 project_id（旧版部分链接仍传 `project`，由前端读取后映射） */
  entrypoint: "chat" | "create" | "workshop" | "quick_create" | "project";
  project_id?: string | null;
  scenario_id?: string | null;
  /** /chat 场景：co_create 自由共创，doc_optimize 文稿优化 */
  chat_mode?: ChatMode | null;
  user_message: string;
  task_input?: TaskInputPayload | null;
  scenario_preset_instructions?: string | null;
  scenario_opening_hint?: string | null;
  /** 与 X-User-ID 双写，防止网关剥离头 */
  user_id?: string | null;
  /** 场景输出优化：来源输出 ID，后端写入 source_material */
  source_output_id?: string | null;
  overrides?: TaskExecuteOverrides;
  stream: boolean;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OrchestrationPreviewResponse {
  payload: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export async function fetchOrchestrationPreview(
  projectId: string,
  body: {
    scenario_id?: string;
    user_message?: string;
    scenario_preset_instructions?: string;
    scenario_opening_hint?: string;
    overrides?: TaskExecuteOverrides;
  },
): Promise<OrchestrationPreviewResponse> {
  const res = await apiFetch(`/projects/${projectId}/orchestration/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<OrchestrationPreviewResponse>(res);
}

/** GET /projects/{id}/context 响应，用于对话创作注入编排。 */
export interface ProjectContextResponse {
  project_id: string;
  name: string;
  description: string | null;
  background: string | null;
  audience: string | null;
  attachments: Array<{ id: string; original_filename: string; ingest_status?: string | null }>;
  recent_outputs: Array<{
    id: string;
    title: string | null;
    summary: string | null;
    created_at: string | null;
    status?: string | null;
    kb_indexed?: boolean;
  }>;
  kb_stats?: {
    collection: string;
    attachments_indexed: number;
    outputs_indexed: number;
  } | null;
}

export async function fetchProjectContext(projectId: string): Promise<ProjectContextResponse> {
  return apiGet<ProjectContextResponse>(`/projects/${projectId}/context`);
}

/** 写入 task_input.extra，进入编排合并块。 */
export function formatProjectContextForTaskInput(ctx: ProjectContextResponse): string {
  const lines: string[] = [];
  lines.push(`[项目上下文] ${ctx.name}`);
  const desc = ctx.description?.trim();
  if (desc) lines.push(`说明: ${desc.slice(0, 800)}`);
  const bg = ctx.background?.trim();
  if (bg) lines.push(`背景: ${bg.slice(0, 800)}`);
  const aud = ctx.audience?.trim();
  if (aud) lines.push(`受众: ${aud.slice(0, 400)}`);
  if (ctx.recent_outputs?.length) {
    lines.push("近期输出物：");
    for (const item of ctx.recent_outputs.slice(0, 12)) {
      const title = (item.title?.trim() || "未命名输出").slice(0, 120);
      const summary = item.summary?.trim();
      lines.push(
        `- output_id=${item.id} title=${title}${summary ? ` summary=${summary.slice(0, 160)}` : ""}`,
      );
    }
  }
  if (ctx.attachments?.length) {
    lines.push("项目附件：");
    for (const item of ctx.attachments.slice(0, 32)) {
      lines.push(`- attachment_id=${item.id} filename=${item.original_filename.slice(0, 120)}`);
    }
  }
  const stats = ctx.kb_stats;
  if (stats?.collection) {
    lines.push(
      `项目知识库 collection=${stats.collection}（已索引：附件 ${stats.attachments_indexed} 份，输出 ${stats.outputs_indexed} 篇）；请按需 kb_query 检索，勿假设 prompt 含全文。`,
    );
  }
  return lines.join("\n");
}

/** 将编排预览转为侧栏展示块（替代显式 MCP 注入说明）。 */
export function orchestrationPreviewToBlocks(data: OrchestrationPreviewResponse): ContextBlock[] {
  const snap = data.snapshot ?? {};
  const payload = data.payload ?? {};
  const scenario = typeof payload.scenario === "object" && payload.scenario && "name" in payload.scenario
    ? String((payload.scenario as { name?: string }).name ?? "")
    : "";
  const proj = typeof payload.project === "object" && payload.project && "name" in payload.project
    ? String((payload.project as { name?: string }).name ?? "")
    : "";
  return [
    {
      tool: "orchestration_preview",
      title: `编排预览${proj ? ` · ${proj}` : ""}${scenario ? ` · ${scenario}` : ""}`,
      content: JSON.stringify({ snapshot: snap, summary: { entrypoint: snap.entrypoint, template_id: snap.template_id } }, null, 2),
    },
  ];
}

export async function fetchChatBootstrap(): Promise<ChatBootstrapData> {
  const warnings: string[] = [];

  const [projectsRes, collectionsRes, skillsRes, transportRes] = await Promise.allSettled([
    apiGet<ProjectRecord[]>("/projects/"),
    apiGet<CollectionsResponse>("/kb/collections"),
    apiGet<WorkshopSkillsResponse>("/ws/skills"),
    apiGet<ChatTransportConfig>("/chat/config"),
  ]);

  const projects = projectsRes.status === "fulfilled" ? projectsRes.value : [];
  if (projectsRes.status === "rejected") warnings.push(`项目列表加载失败：${String(projectsRes.reason)}`);

  const collections = collectionsRes.status === "fulfilled" ? collectionsRes.value.collections : [];
  if (collectionsRes.status === "rejected") warnings.push(`知识库集合加载失败：${String(collectionsRes.reason)}`);

  const skills = skillsRes.status === "fulfilled" ? skillsRes.value.skills : [];
  if (skillsRes.status === "rejected") warnings.push(`技能列表加载失败：${String(skillsRes.reason)}`);

  const transport = transportRes.status === "fulfilled" ? transportRes.value : null;
  if (transportRes.status === "rejected") warnings.push(`聊天链路配置加载失败：${String(transportRes.reason)}`);

  return { projects, collections, skills, transport, warnings };
}

export async function buildToolsContext(options: BuildContextOptions): Promise<BuildContextResult> {
  const blocks: ContextBlock[] = [];
  const warnings: string[] = [];
  const tasks: Promise<void>[] = [];

  if (options.includeProject && options.projectId) {
    tasks.push(
      apiGet<ProjectRecord>(`/projects/${options.projectId}`)
        .then((project) => {
          blocks.push(formatProjectBlock(project));
        })
        .catch((error) => {
          warnings.push(`项目上下文获取失败：${String(error)}`);
        }),
    );
  }

  if (options.includeKnowledge && options.collectionName) {
    tasks.push(
      apiFetch("/kb/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection_name: options.collectionName,
          query_text: options.query,
          n_results: 3,
          project_id: options.projectId || undefined,
        }),
      })
        .then((res) => readJson<KbQueryResponse>(res))
        .then((result) => {
          blocks.push(formatKbBlock(options.collectionName!, result));
        })
        .catch((error) => {
          warnings.push(`知识库检索失败：${String(error)}`);
        }),
    );
  }

  if (options.includeSkills) {
    tasks.push(
      Promise.resolve(options.skillSnapshot ?? [])
        .then(async (skills) => {
          if (skills.length > 0) return skills;
          const res = await fetch(apiV1("/ws/skills"), { headers: { ...getApiHeaders() } });
          return readJson<WorkshopSkillsResponse>(res).then((body) => body.skills);
        })
        .then((skills) => {
          blocks.push(formatSkillsBlock(skills));
        })
        .catch((error) => {
          warnings.push(`技能快照获取失败：${String(error)}`);
        }),
    );
  }

  await Promise.all(tasks);

  blocks.sort((a, b) => a.tool.localeCompare(b.tool));
  return {
    toolsContext: renderToolsContext(blocks),
    blocks,
    warnings,
  };
}
