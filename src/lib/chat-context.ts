import { apiFetch, apiGet, readJson, apiV1 } from "@/lib/api";

export interface ChatInit {
  scenarioId: string;
  systemContext: string;
  opener: string;
  timestamp: number;
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
          const res = await fetch(apiV1("/ws/skills"));
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
