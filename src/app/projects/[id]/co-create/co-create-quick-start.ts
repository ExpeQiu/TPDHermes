/**
 * 共创「快捷创作入口」启动编排：场景合同 + 项目文件上下文 → 标准输出物。
 */

import {
  buildAgentModeInstructions,
  resolveExecutionFromAgentMode,
} from "@/app/projects/[id]/co-create/co-create-agent-utils";
import {
  buildQuickStartOutputSyncInstructions,
  isDocumentGenerationPrompt,
} from "@/app/projects/[id]/co-create/co-create-auto-draft";
import {
  buildRewriteSyncInstructions,
  isRewritePrompt,
} from "@/app/projects/[id]/co-create/co-create-auto-patch";
import type { CoCreateAgentMode } from "@/app/projects/[id]/co-create/co-create-types";
import {
  buildCoCreateQuickPrompt,
  type CoCreateQuickEntry,
} from "@/lib/co-create-quick-entries";

export type CoCreateQuickStartScenarioDetail = {
  goal: string | null;
  preset_instructions: string | null;
  output_policy?: Record<string, unknown> | null;
  knowledge_policy?: Record<string, unknown> | null;
};

function normStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

/** 快捷创作：基于项目上下文 + 场景输出合同，生成编排追加指令 */
export function buildQuickStartScenarioContractInstructions(
  entryTitle: string,
  prompt: string,
  scenarioDetail?: CoCreateQuickStartScenarioDetail | null,
): string {
  const title = entryTitle.trim();
  const goal = scenarioDetail?.goal?.trim();
  const sections = normStringList(scenarioDetail?.output_policy?.required_sections);
  const mustTemplate = scenarioDetail?.output_policy?.must_follow_template === true;
  const fileName = title ? (title.endsWith(".md") ? title : `${title}.md`) : "标准输出物.md";

  const lines = [
    "【快捷创作·项目场景输出】本任务须基于当前项目上下文与已绑定场景合同执行，禁止输出与场景无关的通用模板稿。",
    title ? `场景名称：${title}。` : "",
    goal ? `场景目标：${goal}` : "",
    sections.length > 0 ? `输出须覆盖章节：${sections.join("、")}。` : "",
    mustTemplate ? "须遵循场景绑定的输出模版结构与语气。" : "",
    `完成后将标准输出物沉淀为 /输出/${fileName}（与场景入口一致）。`,
    "可调用 kb_query、workshop_generate_from_kb、write_file 等工具；引用项目事实时标注 [^N]。",
  ].filter(Boolean);

  return [buildQuickStartOutputSyncInstructions(title, prompt), lines.join(" ")].join("\n\n");
}

function resolveQuickStartExecution(
  agentMode: CoCreateQuickStartInput["agentMode"],
  pipeline: ReturnType<typeof resolveCoCreatePipelineForQuickStart>,
) {
  const base = resolveExecutionFromAgentMode(agentMode, pipeline);
  if (agentMode === "ask") return base;
  // 快捷创作固定走编排链路（项目 + 场景），不跳过工具/KB 预检索
  return {
    ...base,
    useOrchestration: true,
    skipTools: false,
  };
}

export type CoCreateQuickStartInput = {
  entry: CoCreateQuickEntry;
  scenarioDetail?: CoCreateQuickStartScenarioDetail | null;
  agentMode: CoCreateAgentMode;
  pinnedFileCount: number;
  roundFileCount: number;
};

export type CoCreateQuickStartPlan = {
  prompt: string;
  scenarioId: string;
  scenarioPresetInstructions?: string;
  scenarioPresetInstructionsAppend?: string;
  useOrchestration: boolean;
  skipTools: boolean;
  shouldTryAutoCreateDraft: boolean;
  shouldTryAutoPatch: boolean;
  outputEntryTitle: string;
};

export function resolveCoCreateQuickStartPrompt(
  entry: CoCreateQuickEntry,
  scenarioDetail?: CoCreateQuickStartScenarioDetail | null,
): string {
  const goal = scenarioDetail?.goal?.trim();
  if (goal) return buildCoCreateQuickPrompt(goal);
  return entry.prompt;
}

export function resolveCoCreateQuickStartPreset(
  entry: CoCreateQuickEntry,
  scenarioDetail?: CoCreateQuickStartScenarioDetail | null,
): string {
  const fromDetail = scenarioDetail?.preset_instructions?.trim();
  if (fromDetail) return fromDetail;
  return entry.presetInstructions.trim();
}

function resolveCoCreatePipelineForQuickStart(input: CoCreateQuickStartInput) {
  const hasTargetFile = input.pinnedFileCount > 0 || input.roundFileCount > 0;
  const text = resolveCoCreateQuickStartPrompt(input.entry, input.scenarioDetail);
  const compact = text.replace(/\s+/g, "");
  if (CO_CREATE_REWRITE_RE.test(compact)) return "rewrite" as const;
  if (hasTargetFile && isRewritePrompt(text, { hasTargetFile: true })) return "rewrite" as const;
  if (isDocumentGenerationPrompt(text)) return "co_create" as const;
  if (CO_CREATE_RESEARCH_RE.test(compact)) return "co_create" as const;
  return "co_create" as const;
}

const CO_CREATE_REWRITE_RE =
  /\/(生成新文件|改写当前文件)|修改|改写|重写|润色|增加|补充|加入|添加|创建|新建|保存|写入|覆盖|patch|diff|apply/i;
const CO_CREATE_RESEARCH_RE =
  /研究|分析|深度|拆解|挖掘|对标|矩阵|趋势|策略|行业|市场|用户|竞品|报告/i;

export function buildCoCreateQuickStartPlan(
  input: CoCreateQuickStartInput,
): CoCreateQuickStartPlan {
  const prompt = resolveCoCreateQuickStartPrompt(input.entry, input.scenarioDetail);
  const presetInstructions = resolveCoCreateQuickStartPreset(input.entry, input.scenarioDetail);
  const hasTargetFile = input.pinnedFileCount > 0 || input.roundFileCount > 0;
  const pipeline = resolveCoCreatePipelineForQuickStart(input);
  const execution = resolveQuickStartExecution(input.agentMode, pipeline);

  const scenarioPresetInstructionsAppend = [
    buildAgentModeInstructions(input.agentMode),
    buildQuickStartScenarioContractInstructions(input.entry.title, prompt, input.scenarioDetail),
    buildRewriteSyncInstructions(prompt, hasTargetFile),
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    prompt,
    scenarioId: input.entry.scenarioId,
    scenarioPresetInstructions: presetInstructions || undefined,
    scenarioPresetInstructionsAppend: scenarioPresetInstructionsAppend || undefined,
    useOrchestration: execution.useOrchestration,
    skipTools: execution.skipTools,
    shouldTryAutoCreateDraft: execution.allowAutoDraft,
    shouldTryAutoPatch:
      execution.allowAutoDraft && isRewritePrompt(prompt, { hasTargetFile }),
    outputEntryTitle: input.entry.title,
  };
}
