"use client";

import type {
  ChatMode,
  ContextBlock,
  QuickCreateFlowOverrides,
} from "@/lib/chat-context";
import type { CitationSource } from "@/lib/chat-citations";

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolsContext?: string;
  contextBlocks?: ContextBlock[];
  contextWarnings?: string[];
  runId?: string;
  outputId?: string;
  feedbackLevel?: "full" | "partial" | "reject";
  citations?: CitationSource[];
  unresolvedCitationRefs?: number[];
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
}

export type RunAssistantStreamParams = {
  sessionId: string;
  text: string;
  orchestrationPriorMessages: OrchestrationPriorTurn[];
  priorSession: ChatSession;
};
