"use client";

import type { CoCreatePipeline } from "@/app/projects/[id]/co-create/co-create-types";
import type { FileRecommendation } from "@/app/projects/[id]/co-create/co-create-types";
import type { ProjectFileItem } from "@/lib/co-create-api";
import { encodeProjectFileSelectValue } from "@/lib/chat-context";

/** Cursor 式创作模式：Ask 只读 / Agent 全工具 / Plan 先规划后执行 */
export type CoCreateAgentMode = "ask" | "agent" | "plan";

/** 文件变更应用策略：自动写回 vs 人工审阅 */
export type CoCreateApplyMode = "auto" | "review";

export type AgentPlanStep = {
  id: string;
  title: string;
  detail?: string;
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
        description: "先输出计划再执行，偏向深度检索与分析",
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

export function buildAgentModeInstructions(mode: CoCreateAgentMode): string {
  switch (mode) {
    case "ask":
      return [
        "【Ask 只读模式】本轮仅做分析、检索与问答，禁止调用 write_file、patch，禁止输出 tphermes_file_actions。",
        "可正常使用 kb_query、kb_get_entry、tavily_search 等检索工具，并在正文标注 [^N] 引用。",
      ].join(" ");
    case "plan":
      return [
        "【Plan 规划模式】先给出可执行计划，再开始创作。",
        "回复开头须包含 ```tphermes_plan {\"title\":\"...\",\"steps\":[{\"id\":\"1\",\"title\":\"...\",\"detail\":\"...\"}]} ``` JSON 代码块（steps 3-6 项）。",
        "计划输出后，按步骤执行：每完成一步可在 steps 中标注 status=done，涉及文件落地时照常 write_file/patch 并输出 tphermes_file_actions。",
      ].join(" ");
    case "agent":
    default:
      return "";
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
          return {
            id: String(item.id ?? index + 1),
            title,
            detail: typeof item.detail === "string" ? item.detail : undefined,
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
