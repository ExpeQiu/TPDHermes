"use client";

import type {
  ChatMode,
  ContextBlock,
  QuickCreateFlowOverrides,
} from "@/lib/chat-context";
import type { CitationSource } from "@/lib/chat-citations";
import type { CoCreatePipelinePreference } from "@/app/projects/[id]/co-create/co-create-types";

export type MessageRegionExcerpt = {
  fileName: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type AssistantToolEvent = {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  label?: string;
  emoji?: string;
  path?: string;
  summary?: string;
};

/** @deprecated 使用 AssistantToolEvent */
export type AssistantFileToolEvent = AssistantToolEvent;

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 用户输入部分（不含选段引用），用于 UI 分开展示 */
  userPrompt?: string;
  /** 选段引用块，用于 UI 分开展示 */
  regionExcerpts?: MessageRegionExcerpt[];
  toolsContext?: string;
  contextBlocks?: ContextBlock[];
  contextWarnings?: string[];
  runId?: string;
  outputId?: string;
  feedbackLevel?: "full" | "partial" | "reject";
  citations?: CitationSource[];
  unresolvedCitationRefs?: number[];
  fileActions?: import("@/app/projects/[id]/co-create/co-create-types").FileActionProposal[];
  fileRecommendations?: import("@/app/projects/[id]/co-create/co-create-types").FileRecommendation[];
  toolEvents?: AssistantToolEvent[];
  agentPlan?: import("@/app/projects/[id]/co-create/co-create-agent-utils").AgentPlan;
}

export type OrchestrationPriorTurn = { role: "user" | "assistant"; content: string };

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  linkedOutputIds?: string[];
  linkedRunIds?: string[];
  scenarioPresetInstructions?: string;
  scenarioOpeningHint?: string;
  taskEntrySummary?: string;
  quickCreateOverrides?: QuickCreateFlowOverrides;
  selectedProjectId?: string;
  selectedCollection?: string;
  includeProjectContext?: boolean;
  includeKnowledgeContext?: boolean;
  includeSkillsContext?: boolean;
  chatMode?: ChatMode;
  includeFileContext?: boolean;
  selectedFileId?: string;
  rewriteTargetSection?: string;
  rewriteSourceExcerpt?: string;
  rewriteGoal?: string;
  /** 显式会话类型，如 project_co_create */
  sessionKind?: string;
  pinnedFileIds?: string[];
  roundFileIds?: string[];
  archived?: boolean;
  pendingProposalIds?: string[];
  coCreatePipelinePreference?: CoCreatePipelinePreference;
  coCreateAgentMode?: import("@/app/projects/[id]/co-create/co-create-types").CoCreateAgentMode;
  coCreateApplyMode?: import("@/app/projects/[id]/co-create/co-create-types").CoCreateApplyMode;
  /** 共创：Agent 文件变更撤销栈（持久化到 context_json） */
  agentUndoStack?: import("@/app/projects/[id]/co-create/co-create-agent-undo").AgentUndoEntry[];
}

export type RunAssistantStreamParams = {
  sessionId: string;
  text: string;
  orchestrationPriorMessages: OrchestrationPriorTurn[];
  priorSession: ChatSession;
  useOrchestrationOverride?: boolean;
  fastPathEnabled?: boolean;
  scenarioPresetInstructionsAppend?: string;
};
