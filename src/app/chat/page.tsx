"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

import { apiV1 } from "@/lib/api";
import {
  buildChatTaskContextPayload,
  buildToolsContext,
  ALL_PROJECT_FILES_SELECT_VALUE,
  ChatInit,
  ChatMode,
  ChatTransportConfig,
  ContextBlock,
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  fetchChatBootstrap,
  fetchOrchestrationPreview,
  fetchProjectContext,
  fetchProjectFiles,
  formatProjectContextForTaskInput,
  getDocOptimizeBindingStatus,
  isAllProjectFilesSelection,
  orchestrationPreviewToBlocks,
  ProjectFileListItem,
  ProjectRecord,
  type OrchestrationPreviewResponse,
  type ProjectContextResponse,
  type QuickCreateFlowOverrides,
  type TaskExecuteBody,
} from "@/lib/chat-context";
import { getApiHeaders } from "@/lib/api-headers";
import {
  bulkUpsertChatSessions,
  createChatSessionOnServer,
  deleteChatSessionOnServer,
  fetchChatSessionsFull,
  inferSessionKind,
  migrateLocalChatSessions,
} from "@/lib/chat-sessions-api";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import { ensureDerivedUserId, getEffectiveUserIdSync } from "@/lib/user-id";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { chatTransportLabel } from "@/lib/ui-labels";
import { ChatMarkdownWithCitations } from "@/components/chat-markdown-with-citations";
import { ChatMessageQuickActions } from "@/components/chat-message-quick-actions";
import type { CitationSource } from "@/lib/chat-citations";
import { parseTpHermesStreamMeta, fetchRunKbSources } from "@/lib/chat-citations";

interface Message {
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

type OrchestrationPriorTurn = { role: "user" | "assistant"; content: string };

type RunAssistantStreamParams = {
  sessionId: string;
  text: string;
  orchestrationPriorMessages: OrchestrationPriorTurn[];
  priorSession: ChatSession;
};

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  /** 编排执行沉淀的 output_id，供项目详情「查看对话记录」深链定位 */
  linkedOutputIds?: string[];
  linkedRunIds?: string[];
  /** 来自 /create 的编排字段，仅本会话有效，避免跨会话泄漏 */
  scenarioPresetInstructions?: string;
  scenarioOpeningHint?: string;
  taskEntrySummary?: string;
  /** /create 多选知识库、技能子集与输出预设，供编排 overrides 与上下文构建 */
  quickCreateOverrides?: QuickCreateFlowOverrides;
  /** 会话级上下文开关与选择，避免跨会话串扰 */
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

function chatSessionsStorageKey(scopeUserId: string): string {
  return `tphermes-chat-sessions:${scopeUserId}`;
}

function chatActiveStorageKey(scopeUserId: string): string {
  return `tphermes-chat-active:${scopeUserId}`;
}

function loadSessions(scopeUserId: string): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(chatSessionsStorageKey(scopeUserId)) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(scopeUserId: string, sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(chatSessionsStorageKey(scopeUserId), JSON.stringify(sessions));
}

function sessionToServerPayload(session: ChatSession): Record<string, unknown> {
  return {
    ...session,
    sessionKind: inferSessionKind(session as unknown as Record<string, unknown>),
  };
}

function serverSessionToClient(raw: Record<string, unknown>): ChatSession {
  const messages = Array.isArray(raw.messages) ? (raw.messages as Message[]) : [];
  return {
    id: String(raw.id || ""),
    title: String(raw.title || "新对话"),
    messages,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    linkedOutputIds: Array.isArray(raw.linkedOutputIds) ? (raw.linkedOutputIds as string[]) : [],
    linkedRunIds: Array.isArray(raw.linkedRunIds) ? (raw.linkedRunIds as string[]) : [],
    scenarioPresetInstructions:
      typeof raw.scenarioPresetInstructions === "string" ? raw.scenarioPresetInstructions : undefined,
    scenarioOpeningHint: typeof raw.scenarioOpeningHint === "string" ? raw.scenarioOpeningHint : undefined,
    taskEntrySummary: typeof raw.taskEntrySummary === "string" ? raw.taskEntrySummary : undefined,
    quickCreateOverrides:
      raw.quickCreateOverrides && typeof raw.quickCreateOverrides === "object"
        ? (raw.quickCreateOverrides as QuickCreateFlowOverrides)
        : undefined,
    selectedProjectId: typeof raw.selectedProjectId === "string" ? raw.selectedProjectId : "",
    selectedCollection: typeof raw.selectedCollection === "string" ? raw.selectedCollection : "",
    includeProjectContext: Boolean(raw.includeProjectContext),
    includeKnowledgeContext: Boolean(raw.includeKnowledgeContext),
    includeSkillsContext: Boolean(raw.includeSkillsContext),
    chatMode: raw.chatMode === "doc_optimize" ? "doc_optimize" : "co_create",
    includeFileContext: Boolean(raw.includeFileContext),
    selectedFileId: typeof raw.selectedFileId === "string" ? raw.selectedFileId : "",
    rewriteTargetSection: typeof raw.rewriteTargetSection === "string" ? raw.rewriteTargetSection : undefined,
    rewriteSourceExcerpt: typeof raw.rewriteSourceExcerpt === "string" ? raw.rewriteSourceExcerpt : undefined,
    rewriteGoal: typeof raw.rewriteGoal === "string" ? raw.rewriteGoal : undefined,
  };
}

const CHAT_INIT_KEY = "tphermes-chat-init";

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function parseSSEDataPayload(data: string): {
  content: string;
  finishReason: string | null;
  errorText: string | null;
} {
  if (data === "[DONE]" || data === "") {
    return { content: "", finishReason: null, errorText: null };
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.error && typeof parsed.error === "object") {
      const msg = (parsed.error as { message?: string }).message;
      return {
        content: "",
        finishReason: null,
        errorText: typeof msg === "string" ? msg : JSON.stringify(parsed.error),
      };
    }
    const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0] as
      | {
          delta?: { content?: unknown };
          message?: { content?: unknown };
          finish_reason?: unknown;
        }
      | undefined;
    let content = "";
    const delta = choice?.delta;
    if (delta && typeof delta === "object") {
      const dc = delta.content;
      if (typeof dc === "string") content += dc;
    } else {
      const mc = choice?.message?.content ?? parsed.content;
      if (typeof mc === "string") content += mc;
    }
    const fr = choice?.finish_reason;
    const finishReason = typeof fr === "string" && fr.length > 0 ? fr : null;
    return { content, finishReason, errorText: null };
  } catch {
    return { content: "", finishReason: null, errorText: null };
  }
}

function applyStreamMetaToAssistantMessage(
  message: Message,
  meta: ReturnType<typeof parseTpHermesStreamMeta>,
): Message {
  if (!meta) return message;
  const next: Message = { ...message };
  if (meta.runId) next.runId = meta.runId;
  if (meta.outputId) next.outputId = meta.outputId;
  if (meta.citations?.length) next.citations = meta.citations;
  if (meta.unresolvedCitationRefs?.length) {
    next.unresolvedCitationRefs = meta.unresolvedCitationRefs;
  }
  return next;
}

function accumulateSseTextBlock(block: string): {
  text: string;
  finishReason: string | null;
  errorText: string | null;
} {
  let text = "";
  let finishReason: string | null = null;
  let errorText: string | null = null;
  for (const line of block.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      finishReason = finishReason ?? "stop";
      continue;
    }
    const part = parseSSEDataPayload(data);
    if (part.errorText) errorText = part.errorText;
    text += part.content;
    if (part.finishReason) finishReason = part.finishReason;
  }
  return { text, finishReason, errorText };
}

const CHAT_CONTINUE_USER =
  "请接着上文直接输出后续内容，不要重复已经给出的段落。若已全部写完则只回复「（已结束）」三字。";
const CHAT_MAX_CONTINUE_ROUNDS = 12;

function messagesToApiPayload(messages: Message[]): { role: string; content: string }[] {
  return messages
    .filter((m) => !(m.role === "assistant" && m.content.trim() === ""))
    .map((message) => ({
      role: message.role,
      content:
        message.role === "user" && message.toolsContext
          ? `${message.toolsContext}\n\n用户问题：${message.content}`
          : message.content,
    }));
}

function useAutoScroll(depend: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [depend]);
  return ref;
}

function truncate(text: string, max = 180) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const PLACEHOLDER_SESSION_TITLES = new Set(["新对话", "对话创作"]);

function projectChatSessionDefaults(projectId: string): Partial<ChatSession> {
  return {
    selectedProjectId: projectId,
    includeProjectContext: true,
    includeFileContext: true,
    selectedFileId: ALL_PROJECT_FILES_SELECT_VALUE,
    chatMode: "co_create",
  };
}

function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(title.trim());
}

function firstUserMessageContent(session: ChatSession): string | null {
  const msg = session.messages.find((m) => m.role === "user");
  if (!msg) return null;
  const text = msg.content.trim();
  return text || null;
}

/** 将首条用户问题浓缩为侧边栏/顶栏主题名（规则截断，无需额外 LLM 调用） */
function condenseTopicTitle(text: string, maxLen = 16): string {
  let s = text.trim().replace(/\s+/g, " ");
  const firstLine = (s.split(/\n/)[0] ?? s).trim();
  s = firstLine;
  const prefixPatterns = [
    /^请?(帮我|帮忙|协助)?/u,
    /^我想(了解|咨询|问|知道|写|做)?/u,
    /^能否/u,
    /^可以(吗|么)?/u,
    /^关于/u,
    /^请问/u,
  ];
  for (const re of prefixPatterns) {
    const next = s.replace(re, "").trim();
    if (next.length >= 2) s = next;
  }
  s = s.replace(/[？?。！!，,、；;：:.]+$/gu, "").trim();
  if (!s) s = firstLine;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function titleFromSession(session: ChatSession | undefined): string {
  if (!session) return "新对话";
  const first = firstUserMessageContent(session);
  if (first) return condenseTopicTitle(first);
  if (isPlaceholderSessionTitle(session.title)) return "新对话";
  return session.title;
}

function sessionProjectIdentifier(session: ChatSession, projects: ProjectRecord[]): string {
  const projectId = session.selectedProjectId?.trim();
  if (!projectId) return "无关联";
  const project = projects.find((item) => item.id === projectId);
  return project?.name?.trim() || "无关联";
}

function DocOptimizeSessionIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`${className} shrink-0 text-emerald-700 opacity-90 dark:text-emerald-300`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h2M8 17h6M8 9h8" />
    </svg>
  );
}

function sessionListIcon(session: ChatSession) {
  const mode = session.chatMode ?? "co_create";
  if (mode === "doc_optimize") {
    return <DocOptimizeSessionIcon />;
  }
  const kind = inferSessionKind(session as unknown as Record<string, unknown>);
  if (kind === "scenario") {
    return <span className="text-xs">📋</span>;
  }
  return <span className="text-xs">💬</span>;
}

function normalizeSessionsPlaceholders(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => {
    if (!isPlaceholderSessionTitle(session.title)) return session;
    const first = firstUserMessageContent(session);
    if (!first) return session;
    return { ...session, title: condenseTopicTitle(first) };
  });
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          加载对话…
        </div>
      }
    >
      <ChatPageInner />
    </Suspense>
  );
}

type ChatTaskBoundaryModel = {
  activeSession: ChatSession | undefined;
  useOrchestration: boolean;
  transport: ChatTransportConfig | null;
  tasksExecuteUrl: string;
  chatApiBase: string;
  chatMode: ChatMode;
  onChatModeChange: (v: ChatMode) => void;
  includeProjectContext: boolean;
  setIncludeProjectContext: (v: boolean) => void;
  selectedProjectId: string;
  setSelectedProjectId: (v: string) => void;
  projects: ProjectRecord[];
  includeFileContext: boolean;
  setIncludeFileContext: (v: boolean) => void;
  selectedFileId: string;
  setSelectedFileId: (v: string) => void;
  projectFiles: ProjectFileListItem[];
  projectFilesLoading: boolean;
  rewriteTargetSection: string;
  setRewriteTargetSection: (v: string) => void;
  rewriteSourceExcerpt: string;
  setRewriteSourceExcerpt: (v: string) => void;
  rewriteGoal: string;
  setRewriteGoal: (v: string) => void;
  contextSummary: string[];
  bootstrapWarnings: string[];
};

function ChatTaskBoundaryPanel({
  model,
  narrow,
}: {
  model: ChatTaskBoundaryModel;
  narrow: boolean;
}) {
  const {
    activeSession,
    useOrchestration,
    transport,
    tasksExecuteUrl,
    chatApiBase,
    chatMode,
    onChatModeChange,
    includeProjectContext,
    setIncludeProjectContext,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    includeFileContext,
    setIncludeFileContext,
    selectedFileId,
    setSelectedFileId,
    projectFiles,
    projectFilesLoading,
    rewriteTargetSection,
    setRewriteTargetSection,
    rewriteSourceExcerpt,
    setRewriteSourceExcerpt,
    rewriteGoal,
    setRewriteGoal,
    contextSummary,
    bootstrapWarnings,
  } = model;

  const fileSelectDisabled =
    !includeProjectContext || !selectedProjectId || chatMode === "doc_optimize";
  const outputFiles = projectFiles.filter((f) => f.kind === "output");
  const attachmentFiles = projectFiles.filter((f) => f.kind === "attachment");
  const docOptimizeSelectedOutput =
    chatMode === "doc_optimize" && selectedFileId
      ? outputFiles.find(
          (f) =>
            encodeProjectFileSelectValue("output", f.id) === selectedFileId ||
            decodeProjectFileSelectValue(selectedFileId)?.id === f.id,
        )
      : null;
  const docOptimizeBinding =
    chatMode === "doc_optimize"
      ? getDocOptimizeBindingStatus({
          selectedProjectId,
          selectedFileValue: selectedFileId,
          projectFiles,
          projectFilesLoading,
        })
      : null;

  return (
    <div className="rounded-3xl border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-900/50 p-4 md:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">创作边界</p>
        </div>
        <details className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer list-none text-slate-700 dark:text-slate-300 [&::-webkit-details-marker]:hidden">
            <span className="text-xs text-slate-500">链路 · </span>
            {chatTransportLabel({
              useOrchestration,
              proxyMode: transport?.mode,
            })}
          </summary>
          <p className="mt-2 break-all text-xs text-slate-500">
            {useOrchestration ? tasksExecuteUrl : transport?.target ?? chatApiBase}
          </p>
        </details>
      </div>

      <div className="mt-4 grid gap-3 grid-cols-1">
        <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 p-3">
          <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">场景选择</p>
          <select
            value={chatMode}
            onChange={(e) => onChatModeChange(e.target.value as ChatMode)}
            className="mt-2 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white"
          >
            <option value="co_create">对话共创</option>
            <option value="doc_optimize">文稿优化</option>
          </select>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {chatMode === "co_create"
              ? "不限定参照物，可自由对话与输出。"
              : "须选择项目与指定输出物，基于其完整正文做局部优化；改写要求可在对话中说明。"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 p-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
            {chatMode === "doc_optimize" ? "文稿初稿" : "项目上下文（推荐）"}
          </p>
          {chatMode === "doc_optimize" && docOptimizeBinding && !docOptimizeBinding.ready ? (
            <div
              className="mt-3 rounded-xl border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-600/50 dark:bg-amber-950/40 dark:text-amber-200"
              role="status"
            >
              <p className="font-medium">文稿优化须绑定项目与输出物</p>
              <ul className="mt-1.5 list-inside list-disc space-y-0.5">
                {docOptimizeBinding.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3">
            {chatMode !== "doc_optimize" ? (
              <div className="mb-2 flex items-center justify-between">
                <label className="text-xs text-slate-400">携带项目</label>
                <input
                  type="checkbox"
                  checked={includeProjectContext}
                  onChange={(e) => setIncludeProjectContext(e.target.checked)}
                />
              </div>
            ) : (
              <p className="mb-2 text-xs text-slate-400">所属项目（必选）</p>
            )}
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className={`w-full rounded-lg border bg-slate-200 px-3 py-2 text-sm text-slate-900 dark:bg-slate-800 dark:text-white ${
                chatMode === "doc_optimize" && !selectedProjectId
                  ? "border-amber-400 dark:border-amber-600"
                  : "border-slate-300 dark:border-slate-700"
              }`}
            >
              <option value="">
                {chatMode === "doc_optimize" ? "请选择项目（必选）" : "不注入项目"}
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 border-t border-slate-300/60 pt-3 dark:border-slate-700/60">
            {chatMode === "doc_optimize" ? (
              <>
                <p className="text-xs text-slate-400">待优化输出物（必选）</p>
                <select
                  value={selectedFileId}
                  onChange={(e) => setSelectedFileId(e.target.value)}
                  disabled={!selectedProjectId || projectFilesLoading}
                  className={`mt-2 w-full rounded-lg border bg-slate-200 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:opacity-50 dark:bg-slate-800 ${
                    selectedProjectId && !selectedFileId && !projectFilesLoading
                      ? "border-amber-400 dark:border-amber-600"
                      : "border-slate-300 dark:border-slate-700"
                  }`}
                >
                  <option value="">
                    {!selectedProjectId
                      ? "请先选择项目"
                      : projectFilesLoading
                        ? "加载输出物…"
                        : "请选择待优化输出物"}
                  </option>
                  {outputFiles.length === 0 && selectedProjectId && !projectFilesLoading ? (
                    <option value="" disabled>
                      暂无输出物
                    </option>
                  ) : null}
                  {outputFiles.map((file) => (
                    <option
                      key={encodeProjectFileSelectValue("output", file.id)}
                      value={encodeProjectFileSelectValue("output", file.id)}
                    >
                      {file.title}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  {docOptimizeSelectedOutput
                    ? `已选「${docOptimizeSelectedOutput.title}」：服务端将注入其完整正文作为优化对象（非上下文检索）。`
                    : selectedProjectId
                      ? "须指定一篇输出物；改写时将基于全文做局部优化，而非项目背景或知识库片段。"
                      : "选择项目后指定待优化文稿。"}
                </p>
              </>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs text-slate-400">携带具体文件</label>
                  <input
                    type="checkbox"
                    checked={includeFileContext}
                    disabled={fileSelectDisabled}
                    onChange={(e) => setIncludeFileContext(e.target.checked)}
                  />
                </div>
                <select
                  value={selectedFileId}
                  onChange={(e) => setSelectedFileId(e.target.value)}
                  disabled={!includeFileContext}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:opacity-50"
                >
                  <option value="">
                    {includeProjectContext && selectedProjectId
                      ? "不选文件（基于项目背景）"
                      : "请先选择项目"}
                  </option>
                  {includeProjectContext && selectedProjectId ? (
                    <option value={ALL_PROJECT_FILES_SELECT_VALUE}>全部输出物与附件</option>
                  ) : null}
                  {projectFilesLoading ? (
                    <option value="" disabled>
                      加载文件列表…
                    </option>
                  ) : null}
                  {outputFiles.length > 0 ? (
                    <optgroup label="输出物">
                      {outputFiles.map((file) => (
                        <option
                          key={encodeProjectFileSelectValue("output", file.id)}
                          value={encodeProjectFileSelectValue("output", file.id)}
                        >
                          {file.title}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {attachmentFiles.length > 0 ? (
                    <optgroup label="附件">
                      {attachmentFiles.map((file) => (
                        <option
                          key={encodeProjectFileSelectValue("attachment", file.id)}
                          value={encodeProjectFileSelectValue("attachment", file.id)}
                        >
                          {file.title}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  {isAllProjectFilesSelection(selectedFileId)
                    ? `已启用全部输出物与附件（${outputFiles.length} 篇输出，${attachmentFiles.length} 个附件）。`
                    : selectedFileId
                      ? "已选文件：对话将优先基于该文件上下文。"
                      : includeProjectContext && selectedProjectId
                        ? "未选文件：默认基于项目背景信息对话。"
                        : "选择项目后可指定输出物或附件。"}
                </p>
              </>
            )}
          </div>

          {(chatMode === "doc_optimize" || (includeFileContext && selectedFileId)) && (
            <details className="mt-3 border-t border-slate-300/60 pt-3 dark:border-slate-700/60">
              <summary className="cursor-pointer text-xs font-medium text-slate-500">
                局部改写约束
                <span className="ml-1 text-slate-400">（可选）</span>
              </summary>
              <div className="mt-3 space-y-2">
                <input
                  value={rewriteTargetSection}
                  onChange={(e) => setRewriteTargetSection(e.target.value)}
                  placeholder="目标章节/段落（可选）"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-white"
                />
                <textarea
                  value={rewriteSourceExcerpt}
                  onChange={(e) => setRewriteSourceExcerpt(e.target.value)}
                  placeholder="原文片段（可选）"
                  rows={2}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-white"
                />
                <input
                  value={rewriteGoal}
                  onChange={(e) => setRewriteGoal(e.target.value)}
                  placeholder={
                    chatMode === "doc_optimize"
                      ? "改写目标（可选，也可在下方对话中说明）"
                      : "改写目标（可选）"
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-white"
                />
              </div>
            </details>
          )}
        </div>
      </div>

      {activeSession?.taskEntrySummary && (
        <details className="mt-4 rounded-2xl border border-blue-700/30 bg-blue-950/20 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-blue-300">
            创建页带入摘要
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-blue-100">
            {activeSession.taskEntrySummary}
          </pre>
        </details>
      )}

      <div className="mt-4 rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">边界摘要</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {contextSummary.length === 0 ? (
            <span className="rounded-full border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 px-2 py-1 text-slate-500">
              当前未启用额外上下文
            </span>
          ) : (
            contextSummary.map((item) => (
              <span
                key={item}
                className="rounded-full border border-blue-300 bg-blue-50 px-2 py-1 text-blue-800 dark:border-blue-700/40 dark:bg-blue-900/30 dark:text-blue-300"
              >
                {item}
              </span>
            ))
          )}
        </div>
      </div>

      {bootstrapWarnings.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
          {bootstrapWarnings.join("；")}
        </div>
      )}
    </div>
  );
}

function ChatPageInner() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [preparingContext, setPreparingContext] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsSyncError, setSessionsSyncError] = useState("");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [transport, setTransport] = useState<ChatTransportConfig | null>(null);
  const [bootstrapWarnings, setBootstrapWarnings] = useState<string[]>([]);
  const useOrchestration = process.env.NEXT_PUBLIC_USE_ORCHESTRATION !== "false";
  const showAdvancedOrchestration = process.env.NEXT_PUBLIC_CHAT_ADVANCED_ORCHESTRATION === "true";

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const [includeKnowledgeContext, setIncludeKnowledgeContext] = useState(showAdvancedOrchestration);
  const [includeSkillsContext, setIncludeSkillsContext] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("co_create");
  const [includeFileContext, setIncludeFileContext] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFileListItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [rewriteTargetSection, setRewriteTargetSection] = useState("");
  const [rewriteSourceExcerpt, setRewriteSourceExcerpt] = useState("");
  const [rewriteGoal, setRewriteGoal] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const chatDeepLinkAppliedRef = useRef(false);
  const chatProjectEntryAppliedRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const sessionScopeHydratingRef = useRef(false);
  const sessionsSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const citationHydrateAttemptedRef = useRef<Set<string>>(new Set());

  const chatApiBase =
    process.env.NEXT_PUBLIC_CHAT_API_URL ??
    process.env.NEXT_PUBLIC_HERMES_API_URL ??
    apiV1("/chat/completions");
  const chatApiKey =
    process.env.NEXT_PUBLIC_CHAT_API_KEY ??
    process.env.NEXT_PUBLIC_HERMES_API_KEY ??
    "";

  const searchParams = useSearchParams();
  const router = useRouter();
  const scenarioFromUrl = searchParams?.get("scenario") ?? "";
  /** 标准字段为 project_id；project 仅作旧链接兼容 */
  const projectFromUrl =
    searchParams?.get("project_id") ?? searchParams?.get("project") ?? "";
  const newChatFromUrl = searchParams?.get("new_chat") === "1";
  const sessionIdFromUrl = searchParams?.get("session_id") ?? "";
  const outputIdFromUrl = searchParams?.get("output_id") ?? "";
  const collectionFromUrl = searchParams?.get("collection") ?? "";
  const skillsFromUrl = searchParams?.get("skills") === "1";
  const tasksExecuteUrl = apiV1("/tasks/execute");

  const [orchestrationPreview, setOrchestrationPreview] = useState<OrchestrationPreviewResponse | null>(null);
  const [projectTaskContext, setProjectTaskContext] = useState<ProjectContextResponse | null>(null);
  const scopeUserId = useEffectiveUserScopeId();

  useEffect(() => {
    if (!useOrchestration || !includeProjectContext || !selectedProjectId) {
      setOrchestrationPreview(null);
      return;
    }
    let cancelled = false;
    fetchOrchestrationPreview(selectedProjectId, {
      scenario_id: scenarioFromUrl || undefined,
      user_message: "（编排预览）",
    })
      .then((d) => {
        if (!cancelled) setOrchestrationPreview(d);
      })
      .catch(() => {
        if (!cancelled) setOrchestrationPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [useOrchestration, includeProjectContext, selectedProjectId, scenarioFromUrl]);

  useEffect(() => {
    if (!useOrchestration || !includeProjectContext || !selectedProjectId) {
      setProjectTaskContext(null);
      return;
    }
    let cancelled = false;
    fetchProjectContext(selectedProjectId)
      .then((ctx) => {
        if (!cancelled) setProjectTaskContext(ctx);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[chat] GET /projects/.../context 失败", err);
        }
        if (!cancelled) setProjectTaskContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [useOrchestration, includeProjectContext, selectedProjectId]);

  useEffect(() => {
    if (chatMode === "doc_optimize") {
      setIncludeProjectContext(true);
      setIncludeFileContext(true);
      if (
        isAllProjectFilesSelection(selectedFileId) ||
        decodeProjectFileSelectValue(selectedFileId)?.kind === "attachment"
      ) {
        setSelectedFileId("");
      }
    }
  }, [chatMode, selectedFileId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectFiles([]);
      return;
    }
    let cancelled = false;
    setProjectFilesLoading(true);
    fetchProjectFiles(selectedProjectId)
      .then((files) => {
        if (!cancelled) setProjectFiles(files);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[chat-output-context] 项目文件列表加载失败", err);
        }
        if (!cancelled) setProjectFiles([]);
      })
      .finally(() => {
        if (!cancelled) setProjectFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const activeSession = sessions.find((s) => s.id === activeId);

  const effectiveKbCollection = useMemo(() => {
    if (selectedCollection.trim()) return selectedCollection.trim();
    const fromQc = activeSession?.quickCreateOverrides?.knowledgeCollections?.[0];
    if (fromQc?.trim()) return fromQc.trim();
    return collections[0]?.trim() ?? "";
  }, [activeSession?.quickCreateOverrides?.knowledgeCollections, collections, selectedCollection]);

  const saveAndSet = useCallback(
    (updated: ChatSession[]) => {
      sessionsRef.current = updated;
      setSessions(updated);
      saveSessions(scopeUserId, updated);
      if (!scopeUserId) return;
      if (sessionsSyncTimerRef.current) clearTimeout(sessionsSyncTimerRef.current);
      sessionsSyncTimerRef.current = setTimeout(() => {
        bulkUpsertChatSessions(updated.map((session) => sessionToServerPayload(session)))
          .then(() => setSessionsSyncError(""))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setSessionsSyncError(msg);
            console.warn("[chat] 服务端会话同步失败", err);
          });
      }, 800);
    },
    [scopeUserId],
  );

  const updateSession = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      const next = sessionsRef.current.map((session) =>
        session.id === sessionId ? updater(session) : session,
      );
      saveAndSet(next);
      return next;
    },
    [saveAndSet],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (!scopeUserId) return;
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsSyncError("");

    const bootstrapSessions = async () => {
      const initFromSessions = (saved: ChatSession[]) => {
        const normalized = normalizeSessionsPlaceholders(saved);
        if (normalized.some((s, i) => s.title !== saved[i]?.title)) {
          saveSessions(scopeUserId, normalized);
          console.info("[chat] 已根据首条用户消息回填历史会话主题");
        }
        const active = localStorage.getItem(chatActiveStorageKey(scopeUserId));
        if (normalized.length === 0) {
          const first: ChatSession = {
            id: uuid(),
            title: "新对话",
            messages: [],
            createdAt: Date.now(),
            selectedProjectId: "",
            selectedCollection: "",
            includeProjectContext: false,
            includeKnowledgeContext: false,
            includeSkillsContext: false,
            chatMode: "co_create",
            includeFileContext: false,
            selectedFileId: "",
          };
          saveSessions(scopeUserId, [first]);
          sessionsRef.current = [first];
          setSessions([first]);
          setActiveId(first.id);
          void createChatSessionOnServer(sessionToServerPayload(first)).catch((err) => {
            console.warn("[chat] 创建默认会话失败", err);
          });
        } else {
          sessionsRef.current = normalized;
          setSessions(normalized);
          setActiveId(active && normalized.find((s) => s.id === active) ? active : normalized[0].id);
        }
      };

      try {
        let serverItems = await fetchChatSessionsFull();
        const localRaw = loadSessions(scopeUserId);
        if (serverItems.length === 0 && localRaw.length > 0) {
          const migrated = await migrateLocalChatSessions(localRaw.map((s) => sessionToServerPayload(s)));
          console.info("[chat] 已将本机会话迁移至服务端", migrated);
          serverItems = await fetchChatSessionsFull();
        }
        if (cancelled) return;
        if (serverItems.length > 0) {
          initFromSessions(serverItems.map((item) => serverSessionToClient(item)));
          return;
        }
        initFromSessions(localRaw);
      } catch (err) {
        console.warn("[chat] 拉取服务端会话失败，回退 localStorage", err);
        if (cancelled) return;
        const raw = loadSessions(scopeUserId);
        initFromSessions(raw);
        setSessionsSyncError(err instanceof Error ? err.message : "会话同步失败");
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };

    void bootstrapSessions();
    return () => {
      cancelled = true;
    };
  }, [scopeUserId]);

  useEffect(() => {
    if (sessionsLoading || !activeId) return;
    const session = sessionsRef.current.find((s) => s.id === activeId);
    if (!session) return;

    for (const msg of session.messages) {
      if (msg.role !== "assistant" || !msg.runId || !msg.content.includes("[^")) continue;
      if (msg.citations?.length) continue;
      const hydrateKey = `${msg.id}:${msg.runId}`;
      if (citationHydrateAttemptedRef.current.has(hydrateKey)) continue;
      citationHydrateAttemptedRef.current.add(hydrateKey);

      void fetchRunKbSources(msg.runId)
        .then((fetched) => {
          if (fetched.citations.length === 0 && fetched.unresolvedCitationRefs.length === 0) return;
          updateSession(activeId, (s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === msg.id
                ? {
                    ...m,
                    citations: fetched.citations,
                    unresolvedCitationRefs: fetched.unresolvedCitationRefs,
                  }
                : m,
            ),
          }));
          console.info(
            `[chat] citations hydrated run_id=${msg.runId} count=${fetched.citations.length} unresolved=${fetched.unresolvedCitationRefs.length}`,
          );
        })
        .catch((err) => {
          console.warn("[chat] citation hydrate failed", err);
        });
    }
  }, [activeId, sessions, sessionsLoading, updateSession]);

  useEffect(() => {
    if (!sessions.length || chatDeepLinkAppliedRef.current) return;
    if (!sessionIdFromUrl && !outputIdFromUrl) return;

    let targetId: string | null = null;
    if (sessionIdFromUrl && sessions.some((s) => s.id === sessionIdFromUrl)) {
      targetId = sessionIdFromUrl;
    } else if (outputIdFromUrl) {
      const matched = sessions.find((s) => s.linkedOutputIds?.includes(outputIdFromUrl));
      if (matched) targetId = matched.id;
    }

    if (targetId) {
      setActiveId(targetId);
      localStorage.setItem(chatActiveStorageKey(scopeUserId), targetId);
      setSidebarOpen(true);
      console.info("[chat] 深链定位历史会话", {
        session_id: targetId,
        output_id: outputIdFromUrl || undefined,
      });
    } else if (outputIdFromUrl) {
      setSidebarOpen(true);
      console.info("[chat] 未找到 output_id 对应的历史会话，已展开侧边栏", {
        output_id: outputIdFromUrl,
      });
    }
    chatDeepLinkAppliedRef.current = true;
  }, [sessions, sessionIdFromUrl, outputIdFromUrl, scopeUserId]);

  useEffect(() => {
    fetchChatBootstrap()
      .then((data) => {
        setProjects(data.projects);
        setCollections(data.collections);
        setSkills(data.skills);
        setTransport(data.transport);
        setBootstrapWarnings(data.warnings);
        if (data.collections.length > 0) setSelectedCollection(data.collections[0]);
      })
      .catch((loadError) => {
        setBootstrapWarnings([`上下文配置加载失败：${String(loadError)}`]);
      });
  }, []);

  useEffect(() => {
    if (collectionFromUrl) {
      setSelectedCollection(collectionFromUrl);
      setIncludeKnowledgeContext(true);
    }
    if (skillsFromUrl) {
      setIncludeSkillsContext(true);
    }
  }, [collectionFromUrl, skillsFromUrl]);

  const createSession = useCallback(
    (defaults?: Partial<ChatSession>) => {
      abortRef.current?.abort();
      setStreaming(false);
      setPreparingContext(false);
      setError("");
      setInput("");
      setOrchestrationPreview(null);
      setProjectTaskContext(null);
      const session: ChatSession = {
        id: uuid(),
        title: "新对话",
        messages: [],
        createdAt: Date.now(),
        selectedProjectId: defaults?.selectedProjectId ?? "",
        selectedCollection: defaults?.selectedCollection ?? "",
        includeProjectContext: defaults?.includeProjectContext ?? false,
        includeKnowledgeContext: defaults?.includeKnowledgeContext ?? false,
        includeSkillsContext: defaults?.includeSkillsContext ?? false,
        chatMode: defaults?.chatMode ?? "co_create",
        includeFileContext: defaults?.includeFileContext ?? false,
        selectedFileId: defaults?.selectedFileId ?? "",
        rewriteTargetSection: defaults?.rewriteTargetSection ?? "",
        rewriteSourceExcerpt: defaults?.rewriteSourceExcerpt ?? "",
        rewriteGoal: defaults?.rewriteGoal ?? "",
      };
      const next = [session, ...sessionsRef.current];
      saveAndSet(next);
      setActiveId(session.id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId), session.id);
    },
    [saveAndSet, scopeUserId],
  );

  const handleChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      if (nextMode === chatMode) return;
      const defaults: Partial<ChatSession> = { chatMode: nextMode };
      if (nextMode === "doc_optimize") {
        defaults.includeProjectContext = true;
        defaults.includeFileContext = true;
      }
      createSession(defaults);
    },
    [chatMode, createSession],
  );

  useEffect(() => {
    if (!projectFromUrl || sessionsLoading || !scopeUserId) return;
    if (chatProjectEntryAppliedRef.current) return;

    if (outputIdFromUrl || sessionIdFromUrl) {
      if (projectFromUrl) {
        setSelectedProjectId(projectFromUrl);
        setIncludeProjectContext(true);
      }
      chatProjectEntryAppliedRef.current = true;
      return;
    }

    if (!newChatFromUrl) {
      if (projectFromUrl) {
        setSelectedProjectId(projectFromUrl);
        setIncludeProjectContext(true);
      }
      chatProjectEntryAppliedRef.current = true;
      return;
    }

    createSession(projectChatSessionDefaults(projectFromUrl));
    chatProjectEntryAppliedRef.current = true;

    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("new_chat");
    const qs = params.toString();
    router.replace(qs ? `/chat?${qs}` : "/chat", { scroll: false });
  }, [
    createSession,
    newChatFromUrl,
    outputIdFromUrl,
    projectFromUrl,
    router,
    searchParams,
    sessionIdFromUrl,
    sessionsLoading,
    scopeUserId,
  ]);

  useEffect(() => {
    if (!activeId || !activeSession || activeSession.messages.length > 0) return;
    try {
      const raw = sessionStorage.getItem(CHAT_INIT_KEY);
      if (!raw) return;
      const init = JSON.parse(raw) as ChatInit;
      if (Date.now() - init.timestamp > 30 * 60 * 1000) {
        sessionStorage.removeItem(CHAT_INIT_KEY);
        return;
      }

      const preset = (init.systemContext ?? "").trim();
      const opener = (init.opener ?? "").trim();
      const entrySummary = (init.entrySummary ?? "").trim();

      if (init.projectId) {
        setSelectedProjectId(init.projectId);
        setIncludeProjectContext(true);
      }
      if (init.knowledgeCollections && init.knowledgeCollections.length > 0) {
        setSelectedCollection(init.knowledgeCollections[0]);
      } else if (init.selectedCollection) {
        setSelectedCollection(init.selectedCollection);
      }
      if (typeof init.knowledgeEnabled === "boolean") {
        setIncludeKnowledgeContext(init.knowledgeEnabled);
      }
      if (typeof init.skillsEnabled === "boolean") {
        setIncludeSkillsContext(init.skillsEnabled);
      }

      const qc: QuickCreateFlowOverrides = {};
      if (init.knowledgeCollections && init.knowledgeCollections.length > 0) {
        qc.knowledgeCollections = init.knowledgeCollections;
      }
      if (init.selectedSkills && init.selectedSkills.length > 0) {
        qc.skillNames = init.selectedSkills;
      }
      if (init.outputPreset) {
        qc.outputPreset = init.outputPreset;
        if (init.outputPreset === "structured" && init.outputRequiredSections?.length) {
          qc.outputRequiredSections = init.outputRequiredSections;
        }
      }
      const hasQc = Object.keys(qc).length > 0;
      if (hasQc) {
        console.info("[chat] 应用 /create 编排覆盖", qc);
      }

      const initialMessages: Message[] = [];
      if (preset) {
        initialMessages.push({
          id: uuid(),
          role: "system",
          content: `场景预设：\n${preset}`,
        });
      }

      updateSession(activeId, (session) => ({
        ...session,
        scenarioPresetInstructions: preset || undefined,
        scenarioOpeningHint: opener || undefined,
        taskEntrySummary: entrySummary || undefined,
        quickCreateOverrides: hasQc ? qc : undefined,
        messages: initialMessages.length > 0 ? initialMessages : session.messages,
      }));

      setInput(init.opener ?? "");
      sessionStorage.removeItem(CHAT_INIT_KEY);
    } catch {
      // ignore parse errors
    }
  }, [activeId, activeSession, updateSession]);

  useEffect(() => {
    if (!activeSession || !isPlaceholderSessionTitle(activeSession.title)) return;
    const nextTitle = titleFromSession(activeSession);
    if (!isPlaceholderSessionTitle(nextTitle) && nextTitle !== activeSession.title) {
      updateSession(activeSession.id, (session) => ({ ...session, title: nextTitle }));
    }
  }, [activeSession, updateSession]);

  // 切换会话时恢复该会话自己的上下文范围（与其它会话隔离）
  useEffect(() => {
    if (!activeSession) return;
    sessionScopeHydratingRef.current = true;
    setSelectedProjectId(activeSession.selectedProjectId ?? "");
    setSelectedCollection(activeSession.selectedCollection ?? "");
    setIncludeProjectContext(activeSession.includeProjectContext ?? false);
    setIncludeKnowledgeContext(activeSession.includeKnowledgeContext ?? false);
    setIncludeSkillsContext(activeSession.includeSkillsContext ?? false);
    setChatMode(activeSession.chatMode ?? "co_create");
    setIncludeFileContext(activeSession.includeFileContext ?? false);
    setSelectedFileId(activeSession.selectedFileId ?? "");
    setRewriteTargetSection(activeSession.rewriteTargetSection ?? "");
    setRewriteSourceExcerpt(activeSession.rewriteSourceExcerpt ?? "");
    setRewriteGoal(activeSession.rewriteGoal ?? "");
    const timer = window.setTimeout(() => {
      sessionScopeHydratingRef.current = false;
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSession?.id]);

  // 将当前上下文选择回写到活动会话，确保会话间状态独立
  useEffect(() => {
    if (!activeSession || sessionScopeHydratingRef.current) return;
    const same =
      (activeSession.selectedProjectId ?? "") === selectedProjectId &&
      (activeSession.selectedCollection ?? "") === selectedCollection &&
      (activeSession.includeProjectContext ?? false) === includeProjectContext &&
      (activeSession.includeKnowledgeContext ?? false) === includeKnowledgeContext &&
      (activeSession.includeSkillsContext ?? false) === includeSkillsContext &&
      (activeSession.chatMode ?? "co_create") === chatMode &&
      (activeSession.includeFileContext ?? false) === includeFileContext &&
      (activeSession.selectedFileId ?? "") === selectedFileId &&
      (activeSession.rewriteTargetSection ?? "") === rewriteTargetSection &&
      (activeSession.rewriteSourceExcerpt ?? "") === rewriteSourceExcerpt &&
      (activeSession.rewriteGoal ?? "") === rewriteGoal;
    if (same) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      selectedProjectId,
      selectedCollection,
      includeProjectContext,
      includeKnowledgeContext,
      includeSkillsContext,
      chatMode,
      includeFileContext,
      selectedFileId,
      rewriteTargetSection,
      rewriteSourceExcerpt,
      rewriteGoal,
    }));
  }, [
    activeSession,
    chatMode,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    updateSession,
  ]);

  const selectSession = (id: string) => {
    setActiveId(id);
    localStorage.setItem(chatActiveStorageKey(scopeUserId), id);
  };

  const deleteSession = (id: string) => {
    void deleteChatSessionOnServer(id).catch((err) => {
      console.warn("[chat] 删除服务端会话失败", err);
    });
    const next = sessionsRef.current.filter((s) => s.id !== id);
    if (next.length === 0) {
      createSession();
      return;
    }
    saveAndSet(next);
    if (activeIdRef.current === id) {
      setActiveId(next[0].id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId), next[0].id);
    }
  };

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    const outputFiles = projectFiles.filter((f) => f.kind === "output");
    const attachmentFiles = projectFiles.filter((f) => f.kind === "attachment");
    parts.push(`场景: ${chatMode === "doc_optimize" ? "文稿优化" : "对话共创"}`);
    if (chatMode === "doc_optimize") {
      if (selectedProjectId) {
        const project = projects.find((item) => item.id === selectedProjectId);
        parts.push(`项目: ${project?.name ?? "已选"}`);
      } else {
        parts.push("项目: 未选择");
      }
      if (selectedFileId) {
        const decoded = decodeProjectFileSelectValue(selectedFileId);
        const file = decoded
          ? projectFiles.find((f) => f.id === decoded.id && f.kind === decoded.kind)
          : null;
        parts.push(`优化文稿: ${file?.title ?? "已选"}`);
      } else {
        parts.push("优化文稿: 未选择");
      }
      const binding = getDocOptimizeBindingStatus({
        selectedProjectId,
        selectedFileValue: selectedFileId,
        projectFiles,
      });
      if (!binding.ready) {
        parts.push(`待完成: ${binding.issues.join("；")}`);
      }
    } else if (includeProjectContext && selectedProjectId) {
      const project = projects.find((item) => item.id === selectedProjectId);
      parts.push(`项目: ${project?.name ?? "已选"}`);
    }
    if (chatMode !== "doc_optimize") {
    if (isAllProjectFilesSelection(selectedFileId)) {
      parts.push(
        `文件: 全部（${outputFiles.length} 输出 + ${attachmentFiles.length} 附件）`,
      );
    } else if (includeFileContext && selectedFileId) {
      const decoded = decodeProjectFileSelectValue(selectedFileId);
      const file = decoded
        ? projectFiles.find((f) => f.id === decoded.id && f.kind === decoded.kind)
        : null;
      parts.push(`文件: ${file?.title ?? "已选"}`);
    } else if (includeProjectContext && selectedProjectId) {
      parts.push("文件: 项目背景");
    }
    }
    if (includeKnowledgeContext && selectedCollection) {
      const kc = activeSession?.quickCreateOverrides?.knowledgeCollections;
      parts.push(
        kc && kc.length > 1 ? `知识库: ${kc.length} 个（${kc.join("、")}）` : `知识库: ${selectedCollection}`,
      );
    }
    if (includeSkillsContext) {
      const sn = activeSession?.quickCreateOverrides?.skillNames;
      const n = sn?.length ? sn.length : skills.length;
      parts.push(`技能: ${n} 项`);
    }
    return parts;
  }, [
    activeSession?.quickCreateOverrides?.knowledgeCollections,
    activeSession?.quickCreateOverrides?.skillNames,
    chatMode,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    projectFiles,
    projects,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    skills.length,
  ]);

  const runAssistantStream = useCallback(
    async ({
      sessionId,
      text,
      orchestrationPriorMessages,
      priorSession,
    }: RunAssistantStreamParams) => {
      setStreaming(true);
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const assistantId = uuid();
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, { id: assistantId, role: "assistant", content: "" }],
      }));

      let fullContent = "";

      try {
        let resolvedUserId = scopeUserId || getEffectiveUserIdSync();
        if (!resolvedUserId) {
          try {
            resolvedUserId = await ensureDerivedUserId();
          } catch {
            resolvedUserId = "";
          }
        }
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...getApiHeaders(),
        };
        if (resolvedUserId) {
          headers["X-User-ID"] = resolvedUserId;
        }
        if (chatApiKey) headers.Authorization = `Bearer ${chatApiKey}`;

        if (useOrchestration) {
          const qc = priorSession?.quickCreateOverrides;
          const overrides: TaskExecuteBody["overrides"] = {};
          if (showAdvancedOrchestration && includeKnowledgeContext) {
            const cols =
              qc?.knowledgeCollections?.filter(Boolean) ??
              (selectedCollection ? [selectedCollection] : []);
            if (cols.length > 0) {
              overrides.knowledge = { collections: cols };
            }
          }
          if (showAdvancedOrchestration && includeSkillsContext) {
            const list =
              qc?.skillNames && qc.skillNames.length > 0 ? qc.skillNames : skills;
            const allowed = list.slice(0, 32);
            if (allowed.length > 0) {
              overrides.skills = {
                mode: "allowed_list",
                allowed,
                allow_agent_free_choice: false,
              };
            }
          }
          if (qc?.outputPreset === "structured" && qc.outputRequiredSections?.length) {
            overrides.output = {
              must_follow_template: true,
              required_sections: qc.outputRequiredSections,
            };
          }
          let scenarioPresetInstructions =
            priorSession?.scenarioPresetInstructions?.trim() ?? "";
          let scenarioOpeningHint = priorSession?.scenarioOpeningHint?.trim() ?? "";
          if (!scenarioPresetInstructions) {
            const sys = priorSession?.messages.find(
              (m) => m.role === "system" && m.content.trim().length > 0,
            );
            if (sys) {
              scenarioPresetInstructions = sys.content
                .replace(/^\s*场景预设[：:]\s*\n?/, "")
                .trim();
            }
          }
          const ctxExtra =
            chatMode !== "doc_optimize" &&
            includeProjectContext &&
            selectedProjectId &&
            projectTaskContext
              ? formatProjectContextForTaskInput(projectTaskContext)
              : "";
          const taskCtx = buildChatTaskContextPayload({
            chatMode,
            includeProjectContext,
            includeFileContext: includeFileContext || chatMode === "doc_optimize",
            selectedProjectId,
            selectedFileValue: selectedFileId,
            projectFiles,
            projectContextExtra: ctxExtra,
            localRewrite: {
              targetSection: rewriteTargetSection,
              sourceExcerpt: rewriteSourceExcerpt,
              rewriteGoal,
            },
          });
          if (taskCtx.error) {
            throw new Error(taskCtx.error);
          }
          console.info("[chat-output-context] 发送任务", {
            session_id: sessionId,
            chat_mode: chatMode,
            project_id: selectedProjectId || null,
            include_file_context: includeFileContext || chatMode === "doc_optimize",
            selected_file_id: selectedFileId || null,
            source_output_id: taskCtx.sourceOutputId,
          });
          const body: TaskExecuteBody = {
            entrypoint: "chat",
            project_id: includeProjectContext && selectedProjectId ? selectedProjectId : null,
            scenario_id: scenarioFromUrl || "general",
            chat_mode: chatMode,
            user_message: text,
            stream: true,
            messages:
              orchestrationPriorMessages.length > 0 ? orchestrationPriorMessages : undefined,
            overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
            user_id: resolvedUserId || undefined,
          };
          if (taskCtx.sourceOutputId) {
            body.source_output_id = taskCtx.sourceOutputId;
          }
          const extraParts: string[] = [];
          if (taskCtx.taskInputExtra.trim()) extraParts.push(taskCtx.taskInputExtra.trim());
          if (
            chatMode !== "doc_optimize" &&
            !taskCtx.sourceOutputId &&
            ctxExtra.trim() &&
            !(includeFileContext && selectedFileId)
          ) {
            extraParts.push(ctxExtra.trim());
          }
          if (extraParts.length > 0) {
            body.task_input = { extra: extraParts.join("\n\n") };
          }
          if (scenarioPresetInstructions) {
            body.scenario_preset_instructions = scenarioPresetInstructions;
          }
          if (scenarioOpeningHint) {
            body.scenario_opening_hint = scenarioOpeningHint;
          }

          const res = await fetch(tasksExecuteUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
          }

          const reader = res.body?.getReader();
          if (!reader) throw new Error("响应流不可用");
          const decoder = new TextDecoder();
          let buffer = "";

          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              const meta = parseTpHermesStreamMeta(data);
              if (meta?.runId || meta?.citations?.length || meta?.unresolvedCitationRefs?.length) {
                updateSession(sessionId, (session) => ({
                  ...session,
                  linkedOutputIds:
                    meta.outputId != null
                      ? [...new Set([...(session.linkedOutputIds ?? []), meta.outputId])]
                      : session.linkedOutputIds,
                  linkedRunIds: meta.runId
                    ? [...new Set([...(session.linkedRunIds ?? []), meta.runId])]
                    : session.linkedRunIds,
                  messages: session.messages.map((message) =>
                    message.id === assistantId
                      ? applyStreamMetaToAssistantMessage(message, meta)
                      : message,
                  ),
                }));
                if (meta.runId) {
                  console.info(
                    `[chat] orchestration completed run_id=${meta.runId} output_id=${meta.outputId ?? ""} citations=${meta.citations?.length ?? 0}`,
                  );
                }
              }
              const part = parseSSEDataPayload(data);
              if (part.errorText) throw new Error(part.errorText);
              if (part.content) {
                fullContent += part.content;
                updateSession(sessionId, (session) => ({
                  ...session,
                  messages: session.messages.map((message) =>
                    message.id === assistantId ? { ...message, content: fullContent } : message,
                  ),
                }));
              }
            }
          }

          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              const meta = parseTpHermesStreamMeta(data);
              if (meta?.runId || meta?.citations?.length || meta?.unresolvedCitationRefs?.length) {
                updateSession(sessionId, (session) => ({
                  ...session,
                  linkedOutputIds:
                    meta.outputId != null
                      ? [...new Set([...(session.linkedOutputIds ?? []), meta.outputId])]
                      : session.linkedOutputIds,
                  linkedRunIds: meta.runId
                    ? [...new Set([...(session.linkedRunIds ?? []), meta.runId])]
                    : session.linkedRunIds,
                  messages: session.messages.map((message) =>
                    message.id === assistantId
                      ? applyStreamMetaToAssistantMessage(message, meta)
                      : message,
                  ),
                }));
                if (meta.runId) {
                  console.info(`[chat] orchestration completed run_id=${meta.runId}`);
                }
              }
              const part = parseSSEDataPayload(data);
              if (part.errorText) throw new Error(part.errorText);
              if (part.content) fullContent += part.content;
            }
          }

          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content: fullContent || message.content }
                : message,
            ),
          }));

          const runIdForSources = sessionsRef.current
            .find((s) => s.id === sessionId)
            ?.messages.find((m) => m.id === assistantId)?.runId;
          if (runIdForSources) {
            const existingCitations = sessionsRef.current
              .find((s) => s.id === sessionId)
              ?.messages.find((m) => m.id === assistantId)?.citations;
            if (!existingCitations?.length) {
              try {
                const fetched = await fetchRunKbSources(runIdForSources);
                if (fetched.citations.length > 0 || fetched.unresolvedCitationRefs.length > 0) {
                  updateSession(sessionId, (session) => ({
                    ...session,
                    messages: session.messages.map((message) =>
                      message.id === assistantId
                        ? {
                            ...message,
                            citations: fetched.citations,
                            unresolvedCitationRefs: fetched.unresolvedCitationRefs,
                          }
                        : message,
                    ),
                  }));
                  console.info(
                    `[chat] kb sources fetched run_id=${runIdForSources} count=${fetched.citations.length} unresolved=${fetched.unresolvedCitationRefs.length}`,
                  );
                }
              } catch (err) {
                console.warn("[chat] fetchRunKbSources failed", err);
              }
            }
          }

        } else {
          for (let continueRound = 0; continueRound < CHAT_MAX_CONTINUE_ROUNDS; continueRound++) {
            if (controller.signal.aborted) break;

            const sessionSnapshot =
              sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? [];
            const basePayload = messagesToApiPayload(sessionSnapshot);
            const messagesPayload =
              continueRound === 0
                ? basePayload
                : [...basePayload, { role: "user" as const, content: CHAT_CONTINUE_USER }];

            if (continueRound > 0) {
              console.info(
                `[chat] hermes 续写第 ${continueRound} 轮，当前助手消息长度 ${fullContent.length} 字符`,
              );
            }

            const res = await fetch(chatApiBase, {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: "hermes-agent",
                messages: messagesPayload,
                stream: true,
              }),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errText = await res.text().catch(() => "");
              throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("响应流不可用");
            const decoder = new TextDecoder();
            let buffer = "";
            let roundFinish: string | null = null;

            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              const { text: chunkText, finishReason, errorText } = accumulateSseTextBlock(
                lines.join("\n"),
              );
              if (errorText) {
                throw new Error(errorText);
              }
              if (finishReason) roundFinish = finishReason;
              if (chunkText) {
                fullContent += chunkText;
                updateSession(sessionId, (session) => ({
                  ...session,
                  messages: session.messages.map((message) =>
                    message.id === assistantId ? { ...message, content: fullContent } : message,
                  ),
                }));
              }
            }

            if (buffer.trim()) {
              const { text: chunkText, finishReason, errorText } = accumulateSseTextBlock(buffer);
              if (errorText) {
                throw new Error(errorText);
              }
              if (finishReason) roundFinish = finishReason;
              if (chunkText) {
                fullContent += chunkText;
              }
            }

            updateSession(sessionId, (session) => ({
              ...session,
              messages: session.messages.map((message) =>
                message.id === assistantId
                  ? { ...message, content: fullContent || message.content }
                  : message,
              ),
            }));

            console.info(
              `[chat] 流结束 round=${continueRound} finish_reason=${roundFinish ?? "（未上报）"} 累计长度=${fullContent.length}`,
            );

            const needContinue = roundFinish === "length";
            if (!needContinue) break;
          }
        }
      } catch (sendError) {
        if ((sendError as Error).name !== "AbortError") {
          setError(`连接失败：${(sendError as Error).message}`);
          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.filter((message) => message.id !== assistantId),
          }));
        }
      } finally {
        setStreaming(false);
      }
    },
    [
      chatApiBase,
      chatApiKey,
      chatMode,
      includeFileContext,
      includeKnowledgeContext,
      includeProjectContext,
      includeSkillsContext,
      orchestrationPreview,
      projectFiles,
      projectTaskContext,
      rewriteGoal,
      rewriteSourceExcerpt,
      rewriteTargetSection,
      scenarioFromUrl,
      scopeUserId,
      selectedCollection,
      selectedFileId,
      selectedProjectId,
      showAdvancedOrchestration,
      skills,
      tasksExecuteUrl,
      updateSession,
      useOrchestration,
    ],
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const sessionId = activeIdRef.current;
    if (!text || !sessionId || streaming || preparingContext) return;

    if (chatMode === "doc_optimize") {
      const binding = getDocOptimizeBindingStatus({
        selectedProjectId,
        selectedFileValue: selectedFileId,
        projectFiles,
        projectFilesLoading,
      });
      if (!binding.ready) {
        setError(`文稿优化须先完成：${binding.issues.join("、")}`);
        return;
      }
    }

    const ctxPreview = buildChatTaskContextPayload({
      chatMode,
      includeProjectContext,
      includeFileContext: includeFileContext || chatMode === "doc_optimize",
      selectedProjectId,
      selectedFileValue: selectedFileId,
      projectFiles,
      projectContextExtra: "",
      localRewrite: {
        targetSection: rewriteTargetSection,
        sourceExcerpt: rewriteSourceExcerpt,
        rewriteGoal,
      },
    });
    if (ctxPreview.error) {
      setError(ctxPreview.error);
      return;
    }

    setError("");
    setPreparingContext(true);

    const priorSession = sessionsRef.current.find((s) => s.id === sessionId);
    const priorMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of priorSession?.messages ?? []) {
      if (m.role === "user" || m.role === "assistant") {
        priorMessages.push({ role: m.role, content: m.content });
      }
    }

    let contextWarnings: string[] = [];
    let contextBlocks: ContextBlock[] = [];
    let toolsContext = "";

    try {
      if (useOrchestration) {
        if (orchestrationPreview) {
          contextBlocks = orchestrationPreviewToBlocks(orchestrationPreview);
        }
      } else if (
        (includeProjectContext && selectedProjectId) ||
        (includeKnowledgeContext && selectedCollection) ||
        includeSkillsContext
      ) {
        const qc = priorSession?.quickCreateOverrides;
        const skillsForContext = (() => {
          if (!includeSkillsContext) return [] as string[];
          if (qc?.skillNames && qc.skillNames.length > 0) return qc.skillNames.slice(0, 32);
          return skills.slice(0, 32);
        })();
        const built = await buildToolsContext({
          query: text,
          projectId: selectedProjectId || undefined,
          collectionName: selectedCollection || undefined,
          includeProject: includeProjectContext,
          includeKnowledge: includeKnowledgeContext,
          includeSkills: skillsForContext.length > 0,
          skillSnapshot: skillsForContext,
        });
        toolsContext = built.toolsContext;
        contextBlocks = built.blocks;
        contextWarnings = built.warnings;
      }
    } finally {
      setPreparingContext(false);
    }

    const userMsg: Message = {
      id: uuid(),
      role: "user",
      content: text,
      toolsContext,
      contextBlocks,
      contextWarnings,
    };

    updateSession(sessionId, (session) => {
      const messages = [...session.messages, userMsg];
      const isFirstUser = !session.messages.some((m) => m.role === "user");
      const next: ChatSession = { ...session, messages };
      if (isFirstUser && isPlaceholderSessionTitle(session.title)) {
        next.title = condenseTopicTitle(text);
        console.info("[chat] 会话主题已根据首问更新", { session_id: sessionId, title: next.title });
      }
      return next;
    });
    setInput("");

    const sessionAfterUser = sessionsRef.current.find((s) => s.id === sessionId);
    if (!sessionAfterUser) return;

    await runAssistantStream({
      sessionId,
      text,
      orchestrationPriorMessages: priorMessages,
      priorSession: sessionAfterUser,
    });
  }, [
    chatMode,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    input,
    orchestrationPreview,
    preparingContext,
    projectFiles,
    projectFilesLoading,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    runAssistantStream,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    showAdvancedOrchestration,
    skills,
    streaming,
    updateSession,
    useOrchestration,
  ]);

  const regenerateAssistantReply = useCallback(
    async (assistantMessageId: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId || streaming || preparingContext) return;

      if (abortRef.current) abortRef.current.abort();

      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;

      const assistantIdx = session.messages.findIndex((m) => m.id === assistantMessageId);
      if (assistantIdx < 0 || session.messages[assistantIdx]?.role !== "assistant") return;

      let userIdx = -1;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        if (session.messages[i]?.role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) {
        setError("找不到对应的用户问题，无法再次生成");
        return;
      }

      const userMsg = session.messages[userIdx];
      const userText = userMsg.content.trim();
      if (!userText) {
        setError("用户问题为空，无法再次生成");
        return;
      }

      const truncatedMessages = session.messages.slice(0, assistantIdx);
      const orchestrationPrior: OrchestrationPriorTurn[] = [];
      for (let i = 0; i < userIdx; i++) {
        const m = truncatedMessages[i];
        if (m.role === "user" || m.role === "assistant") {
          orchestrationPrior.push({ role: m.role, content: m.content });
        }
      }

      setError("");
      updateSession(sessionId, (s) => ({ ...s, messages: truncatedMessages }));
      console.info("[chat] 再次生成", {
        session_id: sessionId,
        assistant_message_id: assistantMessageId,
        user_preview: userText.slice(0, 80),
      });

      const priorSession: ChatSession = { ...session, messages: truncatedMessages };
      await runAssistantStream({
        sessionId,
        text: userText,
        orchestrationPriorMessages: orchestrationPrior,
        priorSession,
      });
    },
    [preparingContext, runAssistantStream, streaming, updateSession],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const messagesEndRef = useAutoScroll(
    activeSession?.messages.map((m) => `${m.role}:${m.content}`).join("") ?? "",
  );

  const selectedSourceOutputId = useMemo(() => {
    if (!selectedFileId) return null;
    const decoded = decodeProjectFileSelectValue(selectedFileId);
    if (decoded?.kind === "output") return decoded.id;
    return null;
  }, [selectedFileId]);

  const docOptimizeBindingReady = useMemo(() => {
    if (chatMode !== "doc_optimize") return true;
    return getDocOptimizeBindingStatus({
      selectedProjectId,
      selectedFileValue: selectedFileId,
      projectFiles,
      projectFilesLoading,
    }).ready;
  }, [chatMode, projectFiles, projectFilesLoading, selectedFileId, selectedProjectId]);

  const docOptimizeBindingHint = useMemo(() => {
    if (chatMode !== "doc_optimize" || docOptimizeBindingReady) return "";
    const { issues } = getDocOptimizeBindingStatus({
      selectedProjectId,
      selectedFileValue: selectedFileId,
      projectFiles,
      projectFilesLoading,
    });
    return `文稿优化须先完成：${issues.join("、")}`;
  }, [
    chatMode,
    docOptimizeBindingReady,
    projectFiles,
    projectFilesLoading,
    selectedFileId,
    selectedProjectId,
  ]);

  const boundaryModel: ChatTaskBoundaryModel = {
    activeSession,
    useOrchestration,
    transport,
    tasksExecuteUrl,
    chatApiBase,
    chatMode,
    onChatModeChange: handleChatModeChange,
    includeProjectContext,
    setIncludeProjectContext,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    includeFileContext,
    setIncludeFileContext,
    selectedFileId,
    setSelectedFileId,
    projectFiles,
    projectFilesLoading,
    rewriteTargetSection,
    setRewriteTargetSection,
    rewriteSourceExcerpt,
    setRewriteSourceExcerpt,
    rewriteGoal,
    setRewriteGoal,
    contextSummary,
    bootstrapWarnings,
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-white">
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-0"
        } flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-slate-300 bg-slate-200 transition-all dark:border-slate-700 dark:bg-slate-800`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-300 p-4 dark:border-slate-700">
          <div>
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">历史记录</span>
            <p className="mt-0.5 text-[10px] text-slate-500">对话与场景生产 · 云端同步</p>
          </div>
          <button
            onClick={() => createSession()}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition"
          >
            + 新对话
          </button>
        </div>

        {sessionsLoading ? (
          <p className="px-4 py-6 text-xs text-slate-500">加载历史记录…</p>
        ) : null}
        {sessionsSyncError ? (
          <p className="mx-4 mt-2 rounded-lg border border-amber-400/40 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            同步异常：{sessionsSyncError.slice(0, 80)}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => selectSession(session.id)}
              className={`group flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-slate-300 dark:border-slate-700/50 transition ${
                session.id === activeId
                  ? "bg-slate-300/70 dark:bg-slate-700/70 text-slate-900 dark:text-white"
                  : "text-slate-400 hover:bg-slate-300/40 dark:bg-slate-700/40 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              {sessionListIcon(session)}
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm">{titleFromSession(session)}</span>
                <span className="block truncate text-[10px] text-slate-500">
                  {sessionProjectIdentifier(session, projects)}
                </span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(session.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex shrink-0 items-center gap-3 border-b border-slate-300 bg-slate-200/80 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/80">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition text-sm"
            >
              {sidebarOpen ? "◀" : "▶"}
            </button>
            <Link href="/" className="text-slate-400 hover:text-slate-900 dark:hover:text-white transition text-sm">
              ← 首页
            </Link>
            <h1 className="text-sm font-semibold text-slate-900 dark:text-white flex-1 truncate">
              {titleFromSession(activeSession)}
            </h1>
            {(preparingContext || streaming) && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                {preparingContext ? "准备上下文" : "生成中"}
              </span>
            )}
          </header>

          <details className="group shrink-0 border-b border-slate-300 bg-slate-200/40 dark:border-slate-700 dark:bg-slate-800/40 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
              <span>创作边界</span>
              <span className="text-xs text-slate-500 group-open:hidden">展开</span>
              <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
            </summary>
            <div className="max-h-[42vh] overflow-y-auto border-t border-slate-300 dark:border-slate-700/50 px-3 pb-3 pt-2">
              <ChatTaskBoundaryPanel model={boundaryModel} narrow={false} />
            </div>
          </details>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-4 px-4 py-4 sm:px-6 md:px-8">
          {(!activeSession || activeSession.messages.length === 0) && (
            <div className="flex min-h-full flex-col items-center justify-center text-slate-500">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-sm">开始一段新对话吧</p>
              <p className="text-xs mt-1 text-slate-600">回车发送 · Shift+回车换行</p>
            </div>
          )}

          {activeSession?.messages.map((msg) => {
            const visibleContextBlocks =
              msg.contextBlocks?.filter((b) => b.tool !== "orchestration_preview") ?? [];

            return (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
            >
              <div
                className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  msg.role === "user"
                    ? "bg-blue-600"
                    : msg.role === "system"
                      ? "bg-orange-600"
                      : "bg-slate-600"
                }`}
              >
                {msg.role === "user" ? "我" : msg.role === "system" ? "⚙" : "AI"}
              </div>

              <div className="max-w-[78%]">
                {visibleContextBlocks.length > 0 && (
                  <div className="mb-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 px-3 py-3 text-xs text-slate-700 dark:text-slate-300">
                    <div className="font-medium text-slate-800 dark:text-slate-200 mb-2">
                      {`已注入 ${visibleContextBlocks.length} 项显式上下文`}
                    </div>
                    <div className="space-y-2">
                      {visibleContextBlocks.map((block) => (
                        <div key={`${msg.id}-${block.tool}`} className="rounded-lg bg-slate-200/70 dark:bg-slate-800/70 p-2">
                          <div className="text-blue-300">{block.tool}</div>
                          <div className="text-slate-800 dark:text-slate-200 mt-1">{block.title}</div>
                          <pre className="whitespace-pre-wrap text-slate-400 mt-1 font-sans">
                            {truncate(block.content, 260)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {msg.contextWarnings && msg.contextWarnings.length > 0 && (
                  <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-300">
                    {msg.contextWarnings.join("；")}
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2.5 min-w-0 ${
                    msg.role === "user"
                      ? "whitespace-pre-wrap text-sm leading-relaxed bg-blue-600 text-white rounded-tr-sm"
                      : msg.role === "system"
                        ? "rounded-tl-sm border border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-700/30 dark:bg-orange-900/50 dark:text-orange-100"
                        : "bg-slate-300 dark:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-tl-sm"
                  }`}
                >
                  {msg.role === "user" ? (
                    msg.content || "…"
                  ) : (
                    <>
                      {msg.content ? (
                        <ChatMarkdownWithCitations
                          content={msg.content}
                          citations={msg.citations}
                          unresolvedCitationRefs={msg.unresolvedCitationRefs}
                          streaming={streaming && msg.role === "assistant" && msg.id === activeSession?.messages[activeSession.messages.length - 1]?.id}
                        />
                      ) : null}
                      {!msg.content && !(streaming && msg.role === "assistant") ? "…" : null}
                      {streaming && msg.role === "assistant" && msg.content === "" ? (
                        <span className="inline-block h-3.5 w-1.5 animate-pulse bg-blue-400" />
                      ) : null}
                    </>
                  )}
                </div>

                {msg.role === "assistant" && msg.content.trim() ? (
                  <ChatMessageQuickActions
                    content={msg.content}
                    role={msg.role}
                    messageId={msg.id}
                    exportTitle={titleFromSession(activeSession)}
                    collectionName={effectiveKbCollection}
                    projectId={selectedProjectId || projectFromUrl}
                    sessionId={activeId}
                    runId={msg.runId}
                    outputId={msg.outputId}
                    scenarioId={scenarioFromUrl || "general"}
                    sourceOutputId={selectedSourceOutputId}
                    onRegenerate={regenerateAssistantReply}
                    actionsDisabled={streaming || preparingContext}
                    initialFeedbackLevel={msg.feedbackLevel}
                  />
                ) : null}
              </div>
            </div>
            );
          })}

          {error && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-sm font-medium">
                !
              </div>
              <div className="max-w-[75%] rounded-2xl rounded-tl-sm border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-700/50 dark:bg-red-900/40 dark:text-red-300">
                ❌ {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="shrink-0 border-t border-slate-300 bg-slate-200/60 py-4 dark:border-slate-700 dark:bg-slate-800/60">
          {docOptimizeBindingHint ? (
            <p className="mb-2 text-center text-xs text-amber-700 dark:text-amber-300">
              {docOptimizeBindingHint}
            </p>
          ) : null}
          <div className={`${CONTENT_MAX_CLASS} flex gap-3 items-end px-4 sm:px-6 md:px-8`}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                docOptimizeBindingHint
                  ? "请先在右侧「文稿初稿」中选择项目与待优化输出物…"
                  : chatMode === "doc_optimize"
                    ? "说明改写要求，回车发送…"
                    : "输入问题，回车发送，Shift+回车换行…"
              }
              rows={1}
              disabled={streaming || preparingContext}
              className="flex-1 bg-slate-300/60 dark:bg-slate-700/60 border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none transition disabled:opacity-50"
              style={{ maxHeight: "9rem", minHeight: "3rem", height: "auto" } as React.CSSProperties}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 144) + "px";
              }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={
                streaming || preparingContext || !input.trim() || !docOptimizeBindingReady
              }
              className={`flex-shrink-0 px-5 py-3 rounded-xl font-medium text-sm transition ${
                streaming || preparingContext || !input.trim() || !docOptimizeBindingReady
                  ? "bg-slate-300 dark:bg-slate-700 text-slate-500 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white"
              }`}
            >
              {preparingContext ? "准备中" : streaming ? "…" : "发送"}
            </button>
            {streaming && (
              <button
                onClick={() => {
                  if (abortRef.current) abortRef.current.abort();
                  setStreaming(false);
                }}
                className="flex-shrink-0 px-4 py-3 rounded-xl text-sm text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-600 hover:bg-slate-300 dark:bg-slate-700 transition"
              >
                停止
              </button>
            )}
          </div>
          <p className="text-xs text-slate-600 mt-2 text-center">
            AI 回复仅供参考，如有疑问请核实信息
          </p>
        </div>
        </div>

        <aside className="hidden h-full min-h-0 w-[min(22rem,32vw)] max-w-sm shrink-0 flex-col overflow-hidden border-l border-slate-300 bg-slate-200/40 dark:border-slate-700 dark:bg-slate-800/40 lg:flex">
          <div className="shrink-0 border-b border-slate-300 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-500 dark:border-slate-700/80">
            创作边界
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <ChatTaskBoundaryPanel model={boundaryModel} narrow />
          </div>
        </aside>
      </div>
    </div>
  );
}
