"use client";

import type { CoCreatePipeline } from "@/app/projects/[id]/co-create/co-create-types";
import type { FileRecommendation } from "@/app/projects/[id]/co-create/co-create-types";
import { CO_CREATE_OUTPUT_WRITE_POLICY } from "@/app/projects/[id]/co-create/co-create-file-policy";
import type { ProjectFileItem } from "@/lib/co-create-api";
import { encodeProjectFileSelectValue } from "@/lib/chat-context";

/** Cursor 式创作模式：Ask 只读 / Agent 全工具 / Plan 先规划后执行 */
export type CoCreateAgentMode = "ask" | "agent" | "plan";

/** Plan 模式对话阶段：规划 → 待确认 → 执行 */
export type CoCreatePlanPhase = "idle" | "awaiting_confirm" | "executing";

/** 文件变更应用策略：自动写回 vs 人工审阅 */
export type CoCreateApplyMode = "auto" | "review";

export type AgentPlanStep = {
  id: string;
  title: string;
  detail?: string;
  /** 建议调用的 workshop skill 名；无合适技能时为 agent */
  skill?: string;
  status?: "pending" | "in_progress" | "done";
};

export type AgentPlan = {
  title?: string;
  steps: AgentPlanStep[];
  raw?: string;
};

const PLAN_BLOCK_RE = /```tphermes_plan\s*\n([\s\S]*?)```/i;
const CHECKLIST_LINE_RE = /^[-*]\s*\[[ xX]\]\s+(.+)$/;

export function coCreateAgentModeMeta(mode: CoCreateAgentMode): {
  label: string;
  description: string;
  badgeClassName: string;
} {
  switch (mode) {
    case "ask":
      return {
        label: "Ask",
        description: "只读问答与检索，不改项目文件",
        badgeClassName:
          "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/70 dark:bg-sky-950/40 dark:text-sky-200",
      };
    case "plan":
      return {
        label: "Plan",
        description: "对话式先规划后执行，每步绑定 Skill 并产出文件",
        badgeClassName:
          "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/70 dark:bg-violet-950/40 dark:text-violet-200",
      };
    case "agent":
    default:
      return {
        label: "Agent",
        description: "全工具共创；短问句快速应答，改写/研究类任务自动加深",
        badgeClassName:
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200",
      };
  }
}

export type PlanModeInstructionContext = {
  planPhase?: CoCreatePlanPhase | "planning" | "revising";
  availableSkills?: string[];
  confirmedPlan?: AgentPlan | null;
};

const PLAN_CONFIRM_RE =
  /^(确认(执行|计划)?|开始执行|按计划执行|执行计划|继续执行|ok|go|yes)$/i;

export function isPlanConfirmPrompt(text: string): boolean {
  return PLAN_CONFIRM_RE.test(text.trim());
}

function formatSkillsHint(skills: string[]): string {
  const list = skills.map((s) => s.trim()).filter(Boolean).slice(0, 24);
  if (list.length === 0) {
    return "当前无预置技能列表，步骤 skill 可填 agent，执行时按需调用 workshop_generate 等工具。";
  }
  return `可用技能（每步须从中选取最匹配的一项，无合适时填 agent）：${list.join("、")}。`;
}

function buildPlanPlanningInstructions(ctx: PlanModeInstructionContext): string {
  const revising = ctx.planPhase === "revising";
  return [
    revising
      ? "【Plan 规划模式·修订计划】根据用户反馈更新计划，本轮仍不执行写文件。"
      : "【Plan 规划模式·规划阶段】本轮仅输出可执行计划，禁止 write_file/patch，禁止 tphermes_file_actions。",
    "回复须包含 ```tphermes_plan {\"title\":\"...\",\"steps\":[{\"id\":\"1\",\"title\":\"...\",\"detail\":\"...\",\"skill\":\"技能名\"}]} ``` JSON（steps 3–6 项，每项含 skill）。",
    formatSkillsHint(ctx.availableSkills ?? []),
    "计划末尾用 1–2 句说明各步 skill 与预期产出，并提示用户：确认后回复「开始执行」，或输入修改意见。",
  ].join(" ");
}

function buildPlanExecutionInstructions(ctx: PlanModeInstructionContext): string {
  const planJson = ctx.confirmedPlan?.raw ?? JSON.stringify(ctx.confirmedPlan ?? {}, null, 2);
  return [
    "【Plan 规划模式·执行阶段】用户已确认计划，按步骤逐步执行并产出结果。",
    "每步优先调用对应 skill 的 workshop_generate / workshop_generate_from_kb；必要时 kb_query、tavily_search。",
    "涉及文件落地时使用 write_file/patch 并输出 tphermes_file_actions，沉淀至 /输出/（TPD outputs 表，右侧「输出物」可见）；引用标注 [^N]。",
    CO_CREATE_OUTPUT_WRITE_POLICY,
    "每完成一步在 steps 中标注 status=done；全部完成后汇总产出路径。",
    `已确认计划：\n\`\`\`tphermes_plan\n${planJson}\n\`\`\``,
  ].join(" ");
}

export function buildAgentModeInstructions(
  mode: CoCreateAgentMode,
  ctx: PlanModeInstructionContext = {},
): string {
  switch (mode) {
    case "ask":
      return [
        "【Ask 只读模式】本轮仅做分析、检索与问答，禁止调用 write_file、patch，禁止输出 tphermes_file_actions。",
        "须依次检索：项目知识库 → 公共真源库（技术点、发言稿等）→ 不足时 tavily_search 联网；正文标注 [^N]。",
      ].join(" ");
    case "plan": {
      const phase = ctx.planPhase ?? "planning";
      if (phase === "executing") {
        return buildPlanExecutionInstructions(ctx);
      }
      return buildPlanPlanningInstructions(ctx);
    }
    case "agent":
    default:
      return CO_CREATE_OUTPUT_WRITE_POLICY;
  }
}

export function resolveExecutionFromAgentMode(
  mode: CoCreateAgentMode,
  autoPipeline: CoCreatePipeline,
): {
  useOrchestration: boolean;
  skipTools: boolean;
  allowFileWrites: boolean;
  allowAutoDraft: boolean;
  effectivePipeline: CoCreatePipeline;
} {
  if (mode === "ask") {
    return {
      useOrchestration: true,
      skipTools: false,
      allowFileWrites: false,
      allowAutoDraft: false,
      effectivePipeline: autoPipeline === "fast" ? "co_create" : autoPipeline,
    };
  }
  if (mode === "plan") {
    return {
      useOrchestration: true,
      skipTools: false,
      allowFileWrites: true,
      allowAutoDraft: true,
      effectivePipeline: autoPipeline === "fast" ? "research" : autoPipeline,
    };
  }
  const useFast = autoPipeline === "fast";
  return {
    useOrchestration: !useFast,
    skipTools: useFast,
    allowFileWrites: true,
    allowAutoDraft: true,
    effectivePipeline: autoPipeline,
  };
}

export function parseAgentPlanFromContent(content: string): AgentPlan | null {
  const block = content.match(PLAN_BLOCK_RE);
  if (block?.[1]) {
    try {
      const parsed = JSON.parse(block[1].trim()) as Record<string, unknown>;
      const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
      const steps: AgentPlanStep[] = stepsRaw
        .map((row, index) => {
          if (typeof row === "string") {
            return { id: String(index + 1), title: row };
          }
          if (typeof row !== "object" || row === null) return null;
          const item = row as Record<string, unknown>;
          const title = String(item.title || item.name || "").trim();
          if (!title) return null;
          const status = item.status;
          const skillRaw = item.skill ?? item.skill_name ?? item.skillName;
          return {
            id: String(item.id ?? index + 1),
            title,
            detail: typeof item.detail === "string" ? item.detail : undefined,
            skill: typeof skillRaw === "string" && skillRaw.trim() ? skillRaw.trim() : undefined,
            status:
              status === "done" || status === "in_progress" || status === "pending"
                ? status
                : undefined,
          };
        })
        .filter((step): step is AgentPlanStep => step !== null);
      if (steps.length > 0) {
        return {
          title: typeof parsed.title === "string" ? parsed.title : undefined,
          steps,
          raw: block[1].trim(),
        };
      }
    } catch {
      // fall through to checklist parsing
    }
  }

  const lines = content.split("\n");
  const checklist: AgentPlanStep[] = [];
  for (const line of lines) {
    const match = line.match(CHECKLIST_LINE_RE);
    if (match?.[1]) {
      checklist.push({
        id: String(checklist.length + 1),
        title: match[1].trim(),
        status: /^\s*[-*]\s*\[[xX]\]/.test(line) ? "done" : "pending",
      });
    }
  }
  if (checklist.length >= 2) {
    return { steps: checklist };
  }
  return null;
}

export function stripAgentPlanBlock(content: string): string {
  return content.replace(PLAN_BLOCK_RE, "").trim();
}

const STOP_WORDS = new Set([
  "请",
  "帮我",
  "基于",
  "当前",
  "项目",
  "生成",
  "输出",
  "分析",
  "一个",
  "这份",
  "关于",
]);

function tokenizeForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/** 根据用户输入启发式推荐项目文件（类似 Cursor @file 建议） */
export function inferFileRecommendations(
  prompt: string,
  files: ProjectFileItem[],
  excludedFileKeys: Set<string>,
  limit = 3,
): FileRecommendation[] {
  const tokens = tokenizeForMatch(prompt);
  if (tokens.length === 0 || files.length === 0) return [];

  const scored = files
    .map((file) => {
      const key = encodeProjectFileSelectValue(file.kind, file.id);
      if (excludedFileKeys.has(key)) return null;
      const haystack = `${file.title} ${file.path ?? ""}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += token.length >= 4 ? 3 : 1;
      }
      if (file.kind === "output") score += 0.5;
      return score > 0 ? { file, score, key } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ file, key }) => ({
    proposalId: `rec:${key}`,
    fileId: file.id,
    fileKind: file.kind,
    fileName: file.title,
    reason: "与当前描述关键词匹配，建议加入上下文",
  }));
}

export const TOOL_EVENT_LABELS: Record<string, { label: string; emoji: string }> = {
  write_file: { label: "写入文件", emoji: "↳" },
  patch: { label: "修改文件", emoji: "✎" },
  kb_query: { label: "检索知识库", emoji: "⌕" },
  search_files: { label: "检索项目文件", emoji: "🔎" },
  kb_get_entry: { label: "读取知识条目", emoji: "📄" },
  kb_list_collections: { label: "列出知识库", emoji: "📚" },
  tavily_search: { label: "联网搜索", emoji: "🌐" },
  tavily_extract: { label: "提取网页", emoji: "🔗" },
  workshop_generate: { label: "结构化生成", emoji: "⚙" },
  workshop_generate_from_kb: { label: "知识库生成", emoji: "⚙" },
};

export function toolEventDisplayName(toolName: string): string {
  return TOOL_EVENT_LABELS[toolName]?.label ?? toolName;
}

export function toolEventEmoji(toolName: string): string {
  return TOOL_EVENT_LABELS[toolName]?.emoji ?? "•";
}
