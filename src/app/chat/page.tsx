"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { apiV1 } from "@/lib/api";
import {
  buildToolsContext,
  ChatInit,
  ChatTransportConfig,
  ContextBlock,
  fetchChatBootstrap,
  fetchOrchestrationPreview,
  fetchProjectContext,
  formatProjectContextForTaskInput,
  orchestrationPreviewToBlocks,
  ProjectRecord,
  type OrchestrationPreviewResponse,
  type ProjectContextResponse,
  type QuickCreateFlowOverrides,
  type TaskExecuteBody,
} from "@/lib/chat-context";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { chatTransportLabel } from "@/lib/ui-labels";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolsContext?: string;
  contextBlocks?: ContextBlock[];
  contextWarnings?: string[];
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  /** 来自 /create 的编排字段，仅本会话有效，避免跨会话泄漏 */
  scenarioPresetInstructions?: string;
  scenarioOpeningHint?: string;
  taskEntrySummary?: string;
  /** /create 多选知识库、技能子集与输出预设，供编排 overrides 与上下文构建 */
  quickCreateOverrides?: QuickCreateFlowOverrides;
}

const STORAGE_KEY = "tphermes-chat-sessions";
const ACTIVE_KEY = "tphermes-chat-active";
const CHAT_INIT_KEY = "tphermes-chat-init";

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/** Hermes / OpenAI 兼容流：单条 data 解析 */
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

function parseTpHermesTaskMeta(data: string): {
  run_id?: string;
  output_id?: string | null;
  validation?: unknown;
} | null {
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const inner = parsed.tphermes_task as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== "object") return null;
    return {
      run_id: typeof inner.run_id === "string" ? inner.run_id : undefined,
      output_id: typeof inner.output_id === "string" ? inner.output_id : null,
      validation: inner.validation,
    };
  } catch {
    return null;
  }
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

function titleFromSession(session: ChatSession | undefined): string {
  if (!session) return "对话创作";
  const firstUser = session.messages.find((msg) => msg.role === "user");
  if (!firstUser) return session.title === "新对话" ? "对话创作" : session.title;
  const text = firstUser.content.trim();
  return text.slice(0, 20) + (text.length > 20 ? "…" : "");
}

export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-slate-900 text-slate-400 text-sm">
          加载对话…
        </div>
      }
    >
      <ChatPageInner />
    </Suspense>
  );
}

function BoundaryMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-3">
      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-medium leading-relaxed text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-slate-500">{hint}</p> : null}
    </div>
  );
}

type BoundaryCard = { label: string; value: string; hint?: string };

type ChatTaskBoundaryModel = {
  activeSession: ChatSession | undefined;
  boundaryCards: BoundaryCard[];
  useOrchestration: boolean;
  showAdvancedOrchestration: boolean;
  transport: ChatTransportConfig | null;
  tasksExecuteUrl: string;
  chatApiBase: string;
  includeProjectContext: boolean;
  setIncludeProjectContext: (v: boolean) => void;
  selectedProjectId: string;
  setSelectedProjectId: (v: string) => void;
  projects: ProjectRecord[];
  includeKnowledgeContext: boolean;
  setIncludeKnowledgeContext: (v: boolean) => void;
  includeSkillsContext: boolean;
  setIncludeSkillsContext: (v: boolean) => void;
  selectedCollection: string;
  setSelectedCollection: (v: string) => void;
  collections: string[];
  contextSummary: string[];
  orchestrationPreview: OrchestrationPreviewResponse | null;
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
    boundaryCards,
    useOrchestration,
    showAdvancedOrchestration,
    transport,
    tasksExecuteUrl,
    chatApiBase,
    includeProjectContext,
    setIncludeProjectContext,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    includeKnowledgeContext,
    setIncludeKnowledgeContext,
    includeSkillsContext,
    setIncludeSkillsContext,
    selectedCollection,
    setSelectedCollection,
    collections,
    contextSummary,
    orchestrationPreview,
    bootstrapWarnings,
  } = model;

  const metricGrid = narrow
    ? "grid gap-3 grid-cols-1"
    : "grid gap-3 md:grid-cols-2 xl:grid-cols-5";
  const settingsGrid = narrow ? "grid gap-4 grid-cols-1" : "grid gap-4 xl:grid-cols-[0.95fr_1.05fr]";
  const innerCols = narrow ? "grid gap-4 grid-cols-1" : "grid gap-4 md:grid-cols-2";

  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-900/50 p-4 md:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">创作边界</p>
          <h2 className="mt-1 text-lg font-semibold text-white">项目 · 知识 · 输出约束</h2>
        </div>
        <details className="rounded-2xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer list-none text-slate-300 [&::-webkit-details-marker]:hidden">
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

      <div className={`mt-4 ${metricGrid}`}>
        {boundaryCards.map((item) => (
          <BoundaryMetric key={item.label} label={item.label} value={item.value} hint={item.hint} />
        ))}
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

      <div className={`mt-4 ${settingsGrid}`}>
        <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">项目上下文（推荐）</p>
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs text-slate-400">携带项目</label>
              <input
                type="checkbox"
                checked={includeProjectContext}
                onChange={(e) => setIncludeProjectContext(e.target.checked)}
              />
            </div>
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
            >
              <option value="">不注入项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-slate-600">
              {useOrchestration ? "请求体标准字段 project_id，并拉取项目 context 摘要" : "调用 mcp_tphermes_project_get"}
            </p>
          </div>
        </div>

        <details
          className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4"
          {...(showAdvancedOrchestration ? { open: true } : {})}
        >
          <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-[0.16em] text-slate-500 [&::-webkit-details-marker]:hidden">
            高级 · 知识 / 技能覆盖
            {showAdvancedOrchestration ? (
              <span className="ml-2 font-normal normal-case text-amber-200/90">（调试开关已开）</span>
            ) : (
              <span className="ml-2 font-normal normal-case text-slate-600">（默认随场景合同）</span>
            )}
          </summary>
          {!showAdvancedOrchestration ? (
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              默认不向前端任务请求写入知识集合与技能白名单覆盖项；由场景编排合同与公共知识库支撑检索与工具范围。若联调需要手动覆盖，请在环境变量中设置{" "}
              <span className="font-mono text-slate-400">NEXT_PUBLIC_CHAT_ADVANCED_ORCHESTRATION=true</span>{" "}
              后刷新页面。
            </p>
          ) : (
            <div className={`mt-4 ${innerCols}`}>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs text-slate-400">知识库范围覆盖</label>
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={includeKnowledgeContext}
                      onChange={(e) => setIncludeKnowledgeContext(e.target.checked)}
                    />
                    启用
                  </label>
                </div>
                <select
                  value={selectedCollection}
                  onChange={(e) => setSelectedCollection(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  disabled={!includeKnowledgeContext}
                >
                  {collections.length === 0 && <option value="">暂无集合</option>}
                  {collections.map((collection) => (
                    <option key={collection} value={collection}>
                      {collection}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs text-slate-400">技能白名单覆盖</label>
                  <label className="flex items-center gap-1 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={includeSkillsContext}
                      onChange={(e) => setIncludeSkillsContext(e.target.checked)}
                    />
                    启用
                  </label>
                </div>
                <p className="text-xs text-slate-600">
                  {useOrchestration ? "写入任务 overrides.skills" : "注入技能快照"}
                </p>
              </div>
            </div>
          )}
        </details>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">边界摘要</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {contextSummary.length === 0 ? (
            <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-slate-500">
              当前未启用额外上下文
            </span>
          ) : (
            contextSummary.map((item) => (
              <span
                key={item}
                className="rounded-full border border-blue-700/40 bg-blue-900/30 px-2 py-1 text-blue-300"
              >
                {item}
              </span>
            ))
          )}
        </div>
      </div>

      {useOrchestration && orchestrationPreview ? (
        <details className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
          <summary className="cursor-pointer text-sm font-medium text-white">编排预览（结构化数据）</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-slate-400">
            {JSON.stringify(orchestrationPreview.snapshot, null, 2)}
          </pre>
        </details>
      ) : (
        <p className="mt-4 text-xs text-slate-600">
          {useOrchestration ? "选择项目后显示编排预览" : "兼容模式无编排快照"}
        </p>
      )}

      {bootstrapWarnings.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
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

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const chatApiBase =
    process.env.NEXT_PUBLIC_CHAT_API_URL ??
    process.env.NEXT_PUBLIC_HERMES_API_URL ??
    apiV1("/chat/completions");
  const chatApiKey =
    process.env.NEXT_PUBLIC_CHAT_API_KEY ??
    process.env.NEXT_PUBLIC_HERMES_API_KEY ??
    "";

  const searchParams = useSearchParams();
  const scenarioFromUrl = searchParams?.get("scenario") ?? "";
  /** 标准字段为 project_id；project 仅作旧链接兼容 */
  const projectFromUrl =
    searchParams?.get("project_id") ?? searchParams?.get("project") ?? "";
  const collectionFromUrl = searchParams?.get("collection") ?? "";
  const skillsFromUrl = searchParams?.get("skills") === "1";
  const tasksExecuteUrl = apiV1("/tasks/execute");

  const [orchestrationPreview, setOrchestrationPreview] = useState<OrchestrationPreviewResponse | null>(null);
  const [projectTaskContext, setProjectTaskContext] = useState<ProjectContextResponse | null>(null);
  const [orchestrationSink, setOrchestrationSink] = useState<{
    output_id?: string | null;
    validation_ok?: boolean;
  } | null>(null);
  const taskMetaRef = useRef<{ output_id?: string | null; validation?: unknown } | null>(null);

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

  const activeSession = sessions.find((s) => s.id === activeId);

  const saveAndSet = useCallback((updated: ChatSession[]) => {
    sessionsRef.current = updated;
    setSessions(updated);
    saveSessions(updated);
  }, []);

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
    const saved = loadSessions();
    const active = localStorage.getItem(ACTIVE_KEY);
    if (saved.length === 0) {
      const first: ChatSession = {
        id: uuid(),
        title: "新对话",
        messages: [],
        createdAt: Date.now(),
      };
      saveSessions([first]);
      sessionsRef.current = [first];
      setSessions([first]);
      setActiveId(first.id);
    } else {
      sessionsRef.current = saved;
      setSessions(saved);
      setActiveId(active && saved.find((s) => s.id === active) ? active : saved[0].id);
    }
  }, []);

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
    if (projectFromUrl) {
      setSelectedProjectId(projectFromUrl);
      setIncludeProjectContext(true);
    }
    if (collectionFromUrl) {
      setSelectedCollection(collectionFromUrl);
      setIncludeKnowledgeContext(true);
    }
    if (skillsFromUrl) {
      setIncludeSkillsContext(true);
    }
  }, [collectionFromUrl, projectFromUrl, skillsFromUrl]);

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
    if (!activeSession || activeSession.title !== "新对话") return;
    const nextTitle = titleFromSession(activeSession);
    if (nextTitle !== activeSession.title) {
      updateSession(activeSession.id, (session) => ({ ...session, title: nextTitle }));
    }
  }, [activeSession, updateSession]);

  const selectSession = (id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
  };

  const createSession = () => {
    const session: ChatSession = {
      id: uuid(),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
    };
    const next = [session, ...sessionsRef.current];
    saveAndSet(next);
    setActiveId(session.id);
    localStorage.setItem(ACTIVE_KEY, session.id);
  };

  const deleteSession = (id: string) => {
    const next = sessionsRef.current.filter((s) => s.id !== id);
    if (next.length === 0) {
      createSession();
      return;
    }
    saveAndSet(next);
    if (activeIdRef.current === id) {
      setActiveId(next[0].id);
      localStorage.setItem(ACTIVE_KEY, next[0].id);
    }
  };

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    if (includeProjectContext && selectedProjectId) {
      const project = projects.find((item) => item.id === selectedProjectId);
      parts.push(`项目: ${project?.name ?? "已选"}`);
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
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    projects,
    selectedCollection,
    selectedProjectId,
    skills.length,
  ]);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const boundaryCards = useMemo(() => {
    const previewPayload = orchestrationPreview?.payload ?? {};
    const qcBound = activeSession?.quickCreateOverrides;
    const output =
      previewPayload.output && typeof previewPayload.output === "object"
        ? (previewPayload.output as Record<string, unknown>)
        : null;
    const skillsPolicy =
      previewPayload.skills && typeof previewPayload.skills === "object"
        ? (previewPayload.skills as Record<string, unknown>)
        : null;
    const knowledgePolicy =
      previewPayload.knowledge && typeof previewPayload.knowledge === "object"
        ? (previewPayload.knowledge as Record<string, unknown>)
        : null;
    const scenario =
      previewPayload.scenario && typeof previewPayload.scenario === "object"
        ? (previewPayload.scenario as Record<string, unknown>)
        : null;

    const templateId =
      typeof output?.template_id === "string"
        ? output.template_id
        : typeof output?.format === "string"
          ? output.format
          : "按任务默认";
    const requiredSections = Array.isArray(output?.required_sections)
      ? output.required_sections.length
      : 0;
    const allowedSkills = Array.isArray(skillsPolicy?.allowed)
      ? skillsPolicy.allowed.length
      : includeSkillsContext
        ? qcBound?.skillNames?.length || skills.length
        : 0;
    const collectionsCount = Array.isArray(knowledgePolicy?.collections)
      ? knowledgePolicy.collections.length
      : includeKnowledgeContext && qcBound?.knowledgeCollections?.length
        ? qcBound.knowledgeCollections.length
        : includeKnowledgeContext && selectedCollection
          ? 1
          : 0;
    const scenarioName =
      typeof scenario?.name === "string" && scenario.name
        ? scenario.name
        : scenarioFromUrl || "general";

    return [
      {
        label: "当前场景",
        value: scenarioName,
        hint: useOrchestration ? "任务接口" : "聊天",
      },
      {
        label: "项目边界",
        value: includeProjectContext ? selectedProject?.name ?? "请选择项目" : "未启用",
        hint:
          includeProjectContext && !selectedProject?.name ? "在下方面板选择项目" : undefined,
      },
      {
        label: "知识边界",
        value: includeKnowledgeContext ? `${collectionsCount} 个范围` : "未启用",
        hint: includeKnowledgeContext ? selectedCollection || "默认" : undefined,
      },
      {
        label: "输出约束",
        value: templateId,
        hint: requiredSections > 0 ? `${requiredSections} 个必填章` : undefined,
      },
      {
        label: "技能范围",
        value: includeSkillsContext ? `${allowedSkills || skills.length} 项` : "未启用",
      },
    ];
  }, [
    activeSession?.quickCreateOverrides,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    orchestrationPreview?.payload,
    scenarioFromUrl,
    selectedCollection,
    selectedProject?.name,
    skills.length,
    useOrchestration,
  ]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const sessionId = activeIdRef.current;
    if (!text || !sessionId || streaming || preparingContext) return;

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

    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, userMsg],
    }));
    setInput("");

    setStreaming(true);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = uuid();
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, { id: assistantId, role: "assistant", content: "" }],
    }));

    taskMetaRef.current = null;
    setOrchestrationSink(null);

    let fullContent = "";

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
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
            scenarioPresetInstructions = sys.content.replace(/^\s*场景预设[：:]\s*\n?/, "").trim();
          }
        }
        const ctxExtra =
          includeProjectContext && selectedProjectId && projectTaskContext
            ? formatProjectContextForTaskInput(projectTaskContext)
            : "";
        const body: TaskExecuteBody = {
          entrypoint: "chat",
          project_id: includeProjectContext && selectedProjectId ? selectedProjectId : null,
          scenario_id: scenarioFromUrl || "general",
          user_message: text,
          stream: true,
          messages: priorMessages.length > 0 ? priorMessages : undefined,
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        };
        if (ctxExtra.trim()) {
          body.task_input = { extra: ctxExtra };
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
            const meta = parseTpHermesTaskMeta(data);
            if (meta?.run_id) {
              taskMetaRef.current = {
                output_id: meta.output_id,
                validation: meta.validation,
              };
              console.info(`[chat] orchestration completed run_id=${meta.run_id} output_id=${meta.output_id ?? ""}`);
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
            const meta = parseTpHermesTaskMeta(data);
            if (meta?.run_id) {
              taskMetaRef.current = {
                output_id: meta.output_id,
                validation: meta.validation,
              };
              console.info(`[chat] orchestration completed run_id=${meta.run_id}`);
            }
            const part = parseSSEDataPayload(data);
            if (part.errorText) throw new Error(part.errorText);
            if (part.content) fullContent += part.content;
          }
        }

        updateSession(sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) =>
            message.id === assistantId ? { ...message, content: fullContent || message.content } : message,
          ),
        }));

        const snap = taskMetaRef.current;
        if (snap) {
          const v = snap.validation as { ok?: boolean } | undefined;
          setOrchestrationSink({
            output_id: snap.output_id,
            validation_ok: v && typeof v.ok === "boolean" ? v.ok : true,
          });
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

            const { text, finishReason, errorText } = accumulateSseTextBlock(lines.join("\n"));
            if (errorText) {
              throw new Error(errorText);
            }
            if (finishReason) roundFinish = finishReason;
            if (text) {
              fullContent += text;
              updateSession(sessionId, (session) => ({
                ...session,
                messages: session.messages.map((message) =>
                  message.id === assistantId ? { ...message, content: fullContent } : message,
                ),
              }));
            }
          }

          if (buffer.trim()) {
            const { text, finishReason, errorText } = accumulateSseTextBlock(buffer);
            if (errorText) {
              throw new Error(errorText);
            }
            if (finishReason) roundFinish = finishReason;
            if (text) {
              fullContent += text;
            }
          }

          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.id === assistantId ? { ...message, content: fullContent || message.content } : message,
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
  }, [
    chatApiBase,
    chatApiKey,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    input,
    orchestrationPreview,
    preparingContext,
    projectTaskContext,
    scenarioFromUrl,
    selectedCollection,
    selectedProjectId,
    showAdvancedOrchestration,
    skills,
    streaming,
    tasksExecuteUrl,
    updateSession,
    useOrchestration,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const messagesEndRef = useAutoScroll(
    activeSession?.messages.map((m) => `${m.role}:${m.content}`).join("") ?? "",
  );

  const boundaryModel: ChatTaskBoundaryModel = {
    activeSession,
    boundaryCards,
    useOrchestration,
    showAdvancedOrchestration,
    transport,
    tasksExecuteUrl,
    chatApiBase,
    includeProjectContext,
    setIncludeProjectContext,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    includeKnowledgeContext,
    setIncludeKnowledgeContext,
    includeSkillsContext,
    setIncludeSkillsContext,
    selectedCollection,
    setSelectedCollection,
    collections,
    contextSummary,
    orchestrationPreview,
    bootstrapWarnings,
  };

  return (
    <div className="flex h-screen bg-slate-900 text-white overflow-hidden">
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-0"
        } flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col transition-all overflow-hidden`}
      >
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-300">历史对话</span>
          <button
            onClick={createSession}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition"
          >
            + 新对话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => selectSession(session.id)}
              className={`group flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-slate-700/50 transition ${
                session.id === activeId
                  ? "bg-slate-700/70 text-white"
                  : "text-slate-400 hover:bg-slate-700/40 hover:text-white"
              }`}
            >
              <span className="text-xs">💬</span>
              <span className="text-sm flex-1 truncate">{session.title}</span>
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-slate-800/80">
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              className="text-slate-400 hover:text-white transition text-sm"
            >
              {sidebarOpen ? "◀" : "▶"}
            </button>
            <Link href="/" className="text-slate-400 hover:text-white transition text-sm">
              ← 首页
            </Link>
            <h1 className="text-sm font-semibold text-white flex-1 truncate">
              {titleFromSession(activeSession)}
            </h1>
            {(preparingContext || streaming) && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                {preparingContext ? "准备上下文" : "生成中"}
              </span>
            )}
          </header>

          <details className="group border-b border-slate-700 bg-slate-800/40 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-200 [&::-webkit-details-marker]:hidden">
              <span>创作边界</span>
              <span className="text-xs text-slate-500 group-open:hidden">展开</span>
              <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
            </summary>
            <div className="max-h-[42vh] overflow-y-auto border-t border-slate-700/50 px-3 pb-3 pt-2">
              <ChatTaskBoundaryPanel model={boundaryModel} narrow={false} />
            </div>
          </details>

        <div className="flex-1 overflow-y-auto space-y-4 px-4 py-4 sm:px-6 md:px-8">
          {(!activeSession || activeSession.messages.length === 0) && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
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
                  <div className="mb-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3 text-xs text-slate-300">
                    <div className="font-medium text-slate-200 mb-2">
                      {`已注入 ${visibleContextBlocks.length} 项显式上下文`}
                    </div>
                    <div className="space-y-2">
                      {visibleContextBlocks.map((block) => (
                        <div key={`${msg.id}-${block.tool}`} className="rounded-lg bg-slate-800/70 p-2">
                          <div className="text-blue-300">{block.tool}</div>
                          <div className="text-slate-200 mt-1">{block.title}</div>
                          <pre className="whitespace-pre-wrap text-slate-400 mt-1 font-sans">
                            {truncate(block.content, 260)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {msg.contextWarnings && msg.contextWarnings.length > 0 && (
                  <div className="mb-2 rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                    {msg.contextWarnings.join("；")}
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2.5 min-w-0 ${
                    msg.role === "user"
                      ? "whitespace-pre-wrap text-sm leading-relaxed bg-blue-600 text-white rounded-tr-sm"
                      : msg.role === "system"
                        ? "bg-orange-900/50 text-orange-100 rounded-tl-sm border border-orange-700/30"
                        : "bg-slate-700 text-slate-200 rounded-tl-sm"
                  }`}
                >
                  {msg.role === "user" ? (
                    msg.content || "…"
                  ) : (
                    <>
                      {msg.content ? <ChatMarkdownBody content={msg.content} /> : null}
                      {!msg.content && !(streaming && msg.role === "assistant") ? "…" : null}
                      {streaming && msg.role === "assistant" && msg.content === "" ? (
                        <span className="inline-block h-3.5 w-1.5 animate-pulse bg-blue-400" />
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
            );
          })}

          {error && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-sm font-medium">
                !
              </div>
              <div className="max-w-[75%] rounded-2xl rounded-tl-sm bg-red-900/40 border border-red-700/50 px-4 py-2.5 text-sm text-red-300">
                ❌ {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-slate-700 bg-slate-800/60 py-4">
          {useOrchestration && orchestrationSink && selectedProjectId && includeProjectContext ? (
            <div
              className={`${CONTENT_MAX_CLASS} mb-3 px-4 text-xs leading-relaxed sm:px-6 md:px-8 ${
                orchestrationSink.output_id ? "text-slate-400" : "text-amber-200/90"
              }`}
            >
              {orchestrationSink.output_id ? (
                <span>
                  本轮对话已将助手正文尝试沉淀为项目输出（id{" "}
                  <span className="font-mono text-slate-300">{orchestrationSink.output_id}</span>
                  ）。
                  <Link
                    href={`/projects/${selectedProjectId}`}
                    className="ml-2 text-blue-400 hover:text-blue-300"
                  >
                    打开项目详情
                  </Link>
                </span>
              ) : (
                <span>
                  本轮未写入项目输出（校验未通过、正文为空或策略限制）。可复制助手回复后到「场景输出」继续加工。
                </span>
              )}
            </div>
          ) : null}
          <div className={`${CONTENT_MAX_CLASS} flex gap-3 items-end px-4 sm:px-6 md:px-8`}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，回车发送，Shift+回车换行…"
              rows={1}
              disabled={streaming || preparingContext}
              className="flex-1 bg-slate-700/60 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none transition disabled:opacity-50"
              style={{ maxHeight: "9rem", minHeight: "3rem", height: "auto" } as React.CSSProperties}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 144) + "px";
              }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={streaming || preparingContext || !input.trim()}
              className={`flex-shrink-0 px-5 py-3 rounded-xl font-medium text-sm transition ${
                streaming || preparingContext || !input.trim()
                  ? "bg-slate-700 text-slate-500 cursor-not-allowed"
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
                className="flex-shrink-0 px-4 py-3 rounded-xl text-sm text-slate-300 border border-slate-600 hover:bg-slate-700 transition"
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

        <aside className="hidden min-h-0 w-[min(22rem,32vw)] max-w-sm shrink-0 flex-col border-l border-slate-700 bg-slate-800/40 lg:flex">
          <div className="shrink-0 border-b border-slate-700/80 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
            创作边界
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <ChatTaskBoundaryPanel model={boundaryModel} narrow />
          </div>
        </aside>
      </div>
    </div>
  );
}
