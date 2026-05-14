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
  orchestrationPreviewToBlocks,
  ProjectRecord,
  type OrchestrationPreviewResponse,
  type TaskExecuteBody,
} from "@/lib/chat-context";

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
  if (!session) return "对话";
  const firstUser = session.messages.find((msg) => msg.role === "user");
  if (!firstUser) return session.title;
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
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-3">
      <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-medium leading-relaxed text-white">{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{hint}</p>
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
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const [includeKnowledgeContext, setIncludeKnowledgeContext] = useState(true);
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
  const projectFromUrl = searchParams?.get("project") ?? "";
  const collectionFromUrl = searchParams?.get("collection") ?? "";
  const skillsFromUrl = searchParams?.get("skills") === "1";
  const useOrchestration = process.env.NEXT_PUBLIC_USE_ORCHESTRATION !== "false";
  const tasksExecuteUrl = apiV1("/tasks/execute");

  const [orchestrationPreview, setOrchestrationPreview] = useState<OrchestrationPreviewResponse | null>(null);

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
      if (init.selectedCollection) {
        setSelectedCollection(init.selectedCollection);
      }
      if (typeof init.knowledgeEnabled === "boolean") {
        setIncludeKnowledgeContext(init.knowledgeEnabled);
      }
      if (typeof init.skillsEnabled === "boolean") {
        setIncludeSkillsContext(init.skillsEnabled);
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
      parts.push(`知识库: ${selectedCollection}`);
    }
    if (includeSkillsContext) {
      parts.push(`技能快照: ${skills.length} 项`);
    }
    return parts;
  }, [
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
    const allowedSkills = Array.isArray(skillsPolicy?.allowed) ? skillsPolicy.allowed.length : 0;
    const collectionsCount = Array.isArray(knowledgePolicy?.collections)
      ? knowledgePolicy.collections.length
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
        hint: useOrchestration ? "由统一任务接口承接" : "兼容聊天链路",
      },
      {
        label: "项目边界",
        value: includeProjectContext ? selectedProject?.name ?? "已启用但未选择" : "未启用",
        hint: includeProjectContext ? "项目承担长期上下文" : "本次不绑定项目",
      },
      {
        label: "知识策略",
        value: includeKnowledgeContext ? `${collectionsCount} 个知识范围` : "未启用",
        hint: includeKnowledgeContext ? (selectedCollection || "按默认集合") : "不限制知识范围",
      },
      {
        label: "输出约束",
        value: templateId,
        hint: requiredSections > 0 ? `${requiredSections} 个必填章节` : "按默认模板策略",
      },
      {
        label: "技能策略",
        value: includeSkillsContext ? `${allowedSkills || skills.length} 项候选` : "未启用",
        hint: includeSkillsContext ? "按策略选择技能" : "本次不主动携带技能快照",
      },
    ];
  }, [
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
        const built = await buildToolsContext({
          query: text,
          projectId: selectedProjectId || undefined,
          collectionName: selectedCollection || undefined,
          includeProject: includeProjectContext,
          includeKnowledge: includeKnowledgeContext,
          includeSkills: includeSkillsContext,
          skillSnapshot: skills,
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

    let fullContent = "";

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (chatApiKey) headers.Authorization = `Bearer ${chatApiKey}`;

      if (useOrchestration) {
        const overrides: TaskExecuteBody["overrides"] = {};
        if (includeKnowledgeContext && selectedCollection) {
          overrides.knowledge = { collections: [selectedCollection] };
        }
        if (includeSkillsContext && skills.length > 0) {
          overrides.skills = {
            mode: "allowed_list",
            allowed: skills.slice(0, 32),
            allow_agent_free_choice: false,
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
        const body: TaskExecuteBody = {
          entrypoint: "chat",
          project_id: includeProjectContext && selectedProjectId ? selectedProjectId : null,
          scenario_id: scenarioFromUrl || "general",
          user_message: text,
          stream: true,
          messages: priorMessages.length > 0 ? priorMessages : undefined,
          overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        };
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
    scenarioFromUrl,
    selectedCollection,
    selectedProjectId,
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

      <div className="flex-1 flex flex-col min-w-0">
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
            {activeSession?.title ?? "对话"}
          </h1>
          {(preparingContext || streaming) && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {preparingContext ? "准备上下文" : "生成中"}
            </span>
          )}
        </header>

        <div className="border-b border-slate-700 bg-slate-800/40">
          <div className="mx-auto max-w-5xl px-4 py-4">
            <div className="rounded-3xl border border-slate-700 bg-slate-900/50 p-4 md:p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-2xl">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Task Boundary</p>
                  <h2 className="mt-2 text-lg font-semibold text-white">当前任务边界面板</h2>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    对话页现在固定展示任务边界，不再把快捷编排摘要塞进消息流。这里统一查看项目、知识、技能和输出约束。
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">聊天链路</p>
                  <p className="mt-2 font-medium text-white">
                    {useOrchestration
                      ? "编排任务 · POST /tasks/execute"
                      : transport?.mode === "backend-proxy"
                        ? "TPDHermes 后端代理"
                        : "自定义聊天地址"}
                  </p>
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {useOrchestration ? tasksExecuteUrl : transport?.target ?? chatApiBase}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {boundaryCards.map((item) => (
                  <BoundaryMetric
                    key={item.label}
                    label={item.label}
                    value={item.value}
                    hint={item.hint}
                  />
                ))}
              </div>

              {activeSession?.taskEntrySummary && (
                <div className="mt-4 rounded-2xl border border-blue-700/30 bg-blue-950/20 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-blue-300">快捷编排摘要</p>
                  <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-blue-100">
                    {activeSession.taskEntrySummary}
                  </pre>
                </div>
              )}

              <div className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">边界设置</p>
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <label className="text-xs text-slate-400">项目上下文</label>
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
                      <p className="mt-2 text-xs text-slate-500">
                        {useOrchestration
                          ? "随请求携带 project_id，由后端生成任务边界。"
                          : "发送前显式调用 `mcp_tphermes_project_get`。"}
                      </p>
                    </div>

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <label className="text-xs text-slate-400">知识库与技能</label>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={includeKnowledgeContext}
                              onChange={(e) => setIncludeKnowledgeContext(e.target.checked)}
                            />
                            KB
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={includeSkillsContext}
                              onChange={(e) => setIncludeSkillsContext(e.target.checked)}
                            />
                            技能
                          </label>
                        </div>
                      </div>
                      <select
                        value={selectedCollection}
                        onChange={(e) => setSelectedCollection(e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                      >
                        {collections.length === 0 && <option value="">暂无集合</option>}
                        {collections.map((collection) => (
                          <option key={collection} value={collection}>
                            {collection}
                          </option>
                        ))}
                      </select>
                      <p className="mt-2 text-xs text-slate-500">
                        {useOrchestration
                          ? "知识与技能策略将一并写入本次任务合同。"
                          : "发送前显式调用 KB 与技能快照能力。"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">边界摘要</p>
                    <div className="flex flex-wrap gap-2 text-xs">
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
                    <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
                      <p className="text-sm font-medium text-white">结构化编排预览</p>
                      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-slate-400">
                        {JSON.stringify(orchestrationPreview.snapshot, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 p-4 text-sm text-slate-500">
                      {useOrchestration
                        ? "选择项目后将在此显示当前任务的结构化编排预览。"
                        : "当前是兼容聊天链路模式，暂无结构化编排快照。"}
                    </div>
                  )}

                  {bootstrapWarnings.length > 0 && (
                    <div className="mt-4 rounded-xl border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                      {bootstrapWarnings.join("；")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {(!activeSession || activeSession.messages.length === 0) && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-sm">开始一段新对话吧</p>
              <p className="text-xs mt-1 text-slate-600">
                默认由 TPDHermes 后端转发到 Hermes-agent
              </p>
            </div>
          )}

          {activeSession?.messages.map((msg) => (
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
                {msg.contextBlocks && msg.contextBlocks.length > 0 && (
                  <div className="mb-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3 text-xs text-slate-300">
                    <div className="font-medium text-slate-200 mb-2">
                      {useOrchestration && msg.contextBlocks?.some((b) => b.tool === "orchestration_preview")
                        ? "编排预览（结构化合同）"
                        : `已注入 ${msg.contextBlocks?.length ?? 0} 项显式上下文`}
                    </div>
                    <div className="space-y-2">
                      {msg.contextBlocks.map((block) => (
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
                  className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-tr-sm"
                      : msg.role === "system"
                        ? "bg-orange-900/50 text-orange-100 rounded-tl-sm border border-orange-700/30"
                        : "bg-slate-700 text-slate-200 rounded-tl-sm"
                  }`}
                >
                  {msg.content || (streaming && msg.role === "assistant" ? "" : "…")}
                  {streaming && msg.role === "assistant" && msg.content === "" && (
                    <span className="inline-block w-1.5 h-3.5 bg-blue-400 ml-0.5 animate-pulse" />
                  )}
                </div>
              </div>
            </div>
          ))}

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

        <div className="p-4 border-t border-slate-700 bg-slate-800/60">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
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
              {preparingContext ? "编排中" : streaming ? "…" : "发送"}
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
    </div>
  );
}
