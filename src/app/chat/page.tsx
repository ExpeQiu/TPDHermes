"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { apiFetch, apiV1 } from "@/lib/api";
import {
  ChatInit,
  ChatMode,
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  fetchChatBootstrap,
  fetchOrchestrationPreview,
  fetchProjectContext,
  getDocOptimizeBindingStatus,
  isAllProjectFilesSelection,
  ProjectRecord,
  type OrchestrationPreviewResponse,
  type ProjectContextResponse,
  type QuickCreateFlowOverrides,
  type WorkshopSkillCatalogItem,
} from "@/lib/chat-context";
import {
  chatSkillOptions,
  extractMentionedSkillNames,
  filterSkillMentions,
  skillMentionToken,
  type ChatSkillOption,
} from "@/lib/chat-skill-mentions";
import { inferSessionKind } from "@/lib/chat-sessions-api";
import { fetchRunKbSources } from "@/lib/chat-citations";
import {
  filterBindableKbCollections,
  isKbCollectionHidden,
  kbCollectionDescription,
} from "@/lib/kb-collection-catalog";
import { kbCollectionLabel } from "@/lib/ui-labels";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import type { ChatSession } from "@/app/chat/chat-types";
import { ChatMessageStream } from "@/app/chat/components/chat-message-stream";
import { ProjectFilesRail } from "@/components/project-files-rail";
import { fetchProjectFilesUnified, type ProjectFileItem } from "@/lib/co-create-api";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useChatExecution } from "@/app/chat/hooks/use-chat-execution";
import {
  sessionToPatchPayload,
  useChatSessionStore,
} from "@/app/chat/hooks/use-chat-session-store";

type FirstTokenMetrics = { count: number; totalMs: number };

import {
  condenseTopicTitle,
  getSessionHistoryCategory,
  isChatConversationStarted,
  isPlaceholderSessionTitle,
  isProjectCoCreateSession,
  titleFromSession,
  type SessionHistoryCategory,
} from "@/lib/chat-session-utils";

const CHAT_INIT_KEY = "TPCharness-chat-init";

function useAutoScroll(depend: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [depend]);
  return ref;
}

/** 从项目入口进入对话创作：绑定项目上下文，但不走项目共创会话类型 */
function projectChatSessionDefaults(projectId: string): Partial<ChatSession> {
  return {
    selectedProjectId: projectId,
    includeProjectContext: true,
    includeFileContext: false,
    chatMode: "co_create",
    sessionKind: "chat",
    title: "对话创作",
  };
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

function ContentCreationMark() {
  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        viewBox="0 0 64 64"
        className="h-16 w-16"
        role="img"
        aria-label="内容创作"
      >
        <rect x="2" y="2" width="60" height="60" rx="18" fill="#DBEAFE" className="dark:fill-blue-950" />
        <path
          d="M18 18h15l9 9v19a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V21a3 3 0 0 1 3-3z"
          fill="#FFFFFF"
          stroke="#2563EB"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M33 18v9h9" fill="#BFDBFE" stroke="#2563EB" strokeWidth="2" strokeLinejoin="round" />
        <path d="M21 36h11M21 42h7" fill="none" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" />
        <path d="M36 46c5.2-1.6 8.4-6.4 10.4-11.6" fill="none" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M45.2 32.2l3.2-1.6.4 3.4" fill="none" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function sessionListIcon(session: ChatSession) {
  if (isProjectCoCreateSession(session)) return <span className="text-xs">📁</span>;
  const mode = session.chatMode ?? "co_create";
  if (mode === "doc_optimize") return <DocOptimizeSessionIcon />;
  const kind = inferSessionKind(session as unknown as Record<string, unknown>);
  if (kind === "scenario") return <span className="text-xs">📋</span>;
  return <span className="text-xs">💬</span>;
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

function ChatPageInner() {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState("");
  const [preparingContext, setPreparingContext] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<WorkshopSkillCatalogItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [skillsMenuOpen, setSkillsMenuOpen] = useState(false);
  const [skillCallCounts, setSkillCallCounts] = useState<Record<string, number>>({});
  const [kbMenuOpen, setKbMenuOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState("");
  const [bootstrapWarnings, setBootstrapWarnings] = useState<string[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const showAdvancedOrchestration = process.env.NEXT_PUBLIC_CHAT_ADVANCED_ORCHESTRATION === "true";
  const [includeKnowledgeContext, setIncludeKnowledgeContext] = useState(showAdvancedOrchestration);
  const [includeSkillsContext, setIncludeSkillsContext] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("co_create");
  const [includeFileContext, setIncludeFileContext] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [projectFiles, setProjectFiles] = useState<ProjectFileItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesRefreshKey, setProjectFilesRefreshKey] = useState(0);
  const [rewriteTargetSection, setRewriteTargetSection] = useState("");
  const [rewriteSourceExcerpt, setRewriteSourceExcerpt] = useState("");
  const [rewriteGoal, setRewriteGoal] = useState("");
  const [orchestrationPreview, setOrchestrationPreview] =
    useState<OrchestrationPreviewResponse | null>(null);
  const [projectTaskContext, setProjectTaskContext] = useState<ProjectContextResponse | null>(null);

  const useOrchestration = true;
  const scopeUserId = useEffectiveUserScopeId();
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatDeepLinkAppliedRef = useRef(false);
  const chatProjectEntryAppliedRef = useRef(false);
  const sessionScopeHydratingRef = useRef(false);
  const citationHydrateAttemptedRef = useRef<Set<string>>(new Set());
  const firstTokenMetricsRef = useRef<FirstTokenMetrics>({ count: 0, totalMs: 0 });

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
  const employeeFromUrl = searchParams?.get("employee_id") ?? "";
  const projectFromUrl = searchParams?.get("project_id") ?? searchParams?.get("project") ?? "";
  const newChatFromUrl = searchParams?.get("new_chat") === "1";
  const sessionIdFromUrl = searchParams?.get("session_id") ?? "";
  const outputIdFromUrl = searchParams?.get("output_id") ?? "";
  const collectionFromUrl = searchParams?.get("collection") ?? "";
  const skillsFromUrl = searchParams?.get("skills") === "1";
  const tasksExecuteUrl = apiV1("/tasks/execute");

  const resetTransientState = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingPhase("");
    setPreparingContext(false);
    setError("");
    setInput("");
    setOrchestrationPreview(null);
    setProjectTaskContext(null);
  }, []);

  const {
    sessions,
    activeId,
    setActiveId,
    activeSession,
    sessionsLoading,
    sessionsSyncError,
    setSessionsSyncError,
    sessionsRef,
    activeIdRef,
    updateSession,
    queueSessionPatch,
    queueMessageSync,
    flushSessionToServer,
    createSession,
    selectSession,
    deleteSession,
  } = useChatSessionStore({
    scopeUserId,
    defaultCollection: collections[0]?.trim() ?? "",
    onResetTransientState: resetTransientState,
  });

  const sessionsByCategory = useMemo(() => {
    const grouped: Record<SessionHistoryCategory, ChatSession[]> = {
      chat: [],
      scenario: [],
      co_create: [],
    };
    for (const session of sessions) {
      grouped[getSessionHistoryCategory(session)].push(session);
    }
    return grouped;
  }, [sessions]);

  const workspaceSession = useMemo(() => {
    if (!activeSession || isProjectCoCreateSession(activeSession)) return undefined;
    return activeSession;
  }, [activeSession]);

  const handleHistorySessionClick = useCallback(
    (session: ChatSession) => {
      if (getSessionHistoryCategory(session) === "co_create") {
        const projectId = session.selectedProjectId?.trim();
        if (projectId) {
          router.push(
            `/projects/${projectId}/co-create?session_id=${encodeURIComponent(session.id)}`,
          );
        }
        return;
      }
      selectSession(session.id);
    },
    [router, selectSession],
  );

  const coCreateActiveFixedRef = useRef(false);
  useEffect(() => {
    if (sessionsLoading || coCreateActiveFixedRef.current) return;
    if (activeSession && isProjectCoCreateSession(activeSession)) {
      const fallback = sessionsByCategory.chat[0] ?? sessionsByCategory.scenario[0];
      if (fallback) selectSession(fallback.id);
      coCreateActiveFixedRef.current = true;
    }
  }, [activeSession, selectSession, sessionsByCategory, sessionsLoading]);

  const effectiveKbCollection = useMemo(() => {
    if (selectedCollection.trim()) return selectedCollection.trim();
    const fromQc = activeSession?.quickCreateOverrides?.knowledgeCollections?.[0];
    if (fromQc?.trim()) return fromQc.trim();
    return collections[0]?.trim() ?? "";
  }, [activeSession?.quickCreateOverrides?.knowledgeCollections, collections, selectedCollection]);

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
      .then((data) => {
        if (!cancelled) setOrchestrationPreview(data);
      })
      .catch(() => {
        if (!cancelled) setOrchestrationPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [includeProjectContext, scenarioFromUrl, selectedProjectId, useOrchestration]);

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
  }, [includeProjectContext, selectedProjectId, useOrchestration]);

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

  const boundProjectId = includeProjectContext ? selectedProjectId : "";

  useEffect(() => {
    if (!boundProjectId) {
      setProjectFiles([]);
      setProjectFilesLoading(false);
      return;
    }
    let cancelled = false;
    setProjectFilesLoading(true);
    fetchProjectFilesUnified(boundProjectId)
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
  }, [boundProjectId, projectFilesRefreshKey]);

  useEffect(() => {
    if (sessionsLoading || !activeId) return;
    const session = sessionsRef.current.find((item) => item.id === activeId);
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
          updateSession(activeId, (state) => ({
            ...state,
            messages: state.messages.map((message) =>
              message.id === msg.id
                ? {
                    ...message,
                    citations: fetched.citations,
                    unresolvedCitationRefs: fetched.unresolvedCitationRefs,
                  }
                : message,
            ),
          }));
          const updatedMessage = sessionsRef.current
            .find((item) => item.id === activeId)
            ?.messages.find((item) => item.id === msg.id);
          if (updatedMessage) queueMessageSync(activeId, [updatedMessage], [], 0);
        })
        .catch((err) => {
          console.warn("[chat] citation hydrate failed", err);
        });
    }
  }, [activeId, queueMessageSync, sessionsLoading, sessionsRef, updateSession]);

  useEffect(() => {
    if (!sessions.length || chatDeepLinkAppliedRef.current) return;
    if (!sessionIdFromUrl && !outputIdFromUrl) return;
    let targetId: string | null = null;
    if (sessionIdFromUrl && sessions.some((session) => session.id === sessionIdFromUrl)) {
      targetId = sessionIdFromUrl;
    } else if (outputIdFromUrl) {
      const matched = sessions.find((session) => session.linkedOutputIds?.includes(outputIdFromUrl));
      if (matched) targetId = matched.id;
    }
    if (targetId) {
      setActiveId(targetId);
      localStorage.setItem(`TPCharness-chat-active:${scopeUserId}`, targetId);
      setSidebarOpen(true);
    } else if (outputIdFromUrl) {
      setSidebarOpen(true);
    }
    chatDeepLinkAppliedRef.current = true;
  }, [outputIdFromUrl, scopeUserId, sessionIdFromUrl, sessions, setActiveId]);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/skills/usage?days=30")
      .then(async (res) => {
        if (!res.ok) throw new Error(`skills usage ${res.status}`);
        return (await res.json()) as { skill_usage?: { skill_name?: string; call_count?: number }[] };
      })
      .then((data) => {
        if (cancelled) return;
        const counts: Record<string, number> = {};
        for (const row of data.skill_usage ?? []) {
          const name = row.skill_name?.trim();
          if (!name) continue;
          counts[name] = row.call_count ?? 0;
        }
        setSkillCallCounts(counts);
        console.info("[chat] 常用技能用量", { tracked: Object.keys(counts).length });
      })
      .catch((err) => {
        console.warn("[chat] 常用技能用量加载失败", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchChatBootstrap()
      .then((data) => {
        setProjects(data.projects);
        setCollections(data.collections);
        setSkills(data.skills);
        setSkillCatalog(data.skillCatalog ?? []);
        setBootstrapWarnings(data.warnings);
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
    setSelectedProjectId(projectFromUrl);
    setIncludeProjectContext(true);
    setIncludeFileContext(false);
    if (process.env.NODE_ENV === "development") {
      console.info("[chat] 项目入口新建对话", { project_id: projectFromUrl });
    }
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
      if (typeof init.knowledgeEnabled === "boolean") setIncludeKnowledgeContext(init.knowledgeEnabled);
      if (typeof init.skillsEnabled === "boolean") setIncludeSkillsContext(init.skillsEnabled);

      const qc: QuickCreateFlowOverrides = {};
      if (init.knowledgeCollections?.length) qc.knowledgeCollections = init.knowledgeCollections;
      if (init.selectedSkills?.length) qc.skillNames = init.selectedSkills;
      if (init.outputPreset) {
        qc.outputPreset = init.outputPreset;
        if (init.outputPreset === "structured" && init.outputRequiredSections?.length) {
          qc.outputRequiredSections = init.outputRequiredSections;
        }
      }
      const hasQc = Object.keys(qc).length > 0;
      const initialMessages =
        preset.length > 0
          ? [{ id: `${Date.now()}-system`, role: "system" as const, content: `场景预设：\n${preset}` }]
          : [];

      updateSession(activeId, (session) => ({
        ...session,
        scenarioPresetInstructions: preset || undefined,
        scenarioOpeningHint: opener || undefined,
        taskEntrySummary: entrySummary || undefined,
        quickCreateOverrides: hasQc ? qc : undefined,
        messages: initialMessages.length > 0 ? initialMessages : session.messages,
      }));
      const updatedSession = sessionsRef.current.find((item) => item.id === activeId);
      if (updatedSession) {
        queueSessionPatch(activeId, sessionToPatchPayload(updatedSession), 0);
        if (initialMessages.length > 0) queueMessageSync(activeId, initialMessages, [], 0);
      }
      setInput(init.opener ?? "");
      sessionStorage.removeItem(CHAT_INIT_KEY);
    } catch {
      // ignore parse errors
    }
  }, [activeId, activeSession, queueMessageSync, queueSessionPatch, sessionsRef, updateSession]);

  useEffect(() => {
    if (!activeSession || !isPlaceholderSessionTitle(activeSession.title)) return;
    const nextTitle = titleFromSession(activeSession);
    if (!isPlaceholderSessionTitle(nextTitle) && nextTitle !== activeSession.title) {
      updateSession(activeSession.id, (session) => ({ ...session, title: nextTitle }));
      const updatedSession = sessionsRef.current.find((item) => item.id === activeSession.id);
      if (updatedSession) queueSessionPatch(activeSession.id, { title: updatedSession.title }, 0);
    }
  }, [activeSession, queueSessionPatch, sessionsRef, updateSession]);

  useEffect(() => {
    if (!activeSession || isProjectCoCreateSession(activeSession)) return;
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
  }, [activeSession]);

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
      // /chat 页管理的会话不应被误判为 project_co_create（勾选「携带文件」时）
      sessionKind:
        session.scenarioPresetInstructions ||
        session.quickCreateOverrides ||
        session.taskEntrySummary
          ? "scenario"
          : "chat",
    }));
    const updatedSession = sessionsRef.current.find((item) => item.id === activeSession.id);
    if (updatedSession) queueSessionPatch(activeSession.id, sessionToPatchPayload(updatedSession));
  }, [
    activeSession,
    chatMode,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    queueSessionPatch,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    sessionsRef,
    updateSession,
  ]);

  const visibleCollections = useMemo(
    () => collections.filter((name) => name.trim() && !isKbCollectionHidden(name)),
    [collections],
  );
  const defaultKnowledgeCollections = useMemo(() => {
    const bindable = filterBindableKbCollections(visibleCollections);
    return bindable.length > 0 ? bindable : visibleCollections;
  }, [visibleCollections]);

  const { sendMessage, regenerateAssistantReply } = useChatExecution({
    input,
    streaming,
    preparingContext,
    setStreaming,
    setPreparingContext,
    setStreamingPhase,
    setError,
    setInput,
    setSessionsSyncError,
    chatMode,
    includeFileContext,
    includeKnowledgeContext: true,
    knowledgeCollections: selectedCollection.trim() ? undefined : defaultKnowledgeCollections,
    includeProjectContext,
    includeSkillsContext,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    projectFiles,
    projectFilesLoading,
    projectTaskContext,
    orchestrationPreview,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    scenarioFromUrl,
    employeeId: employeeFromUrl,
    interactionMode: "chat",
    skills,
    showAdvancedOrchestration,
    useOrchestration,
    tasksExecuteUrl,
    chatApiBase,
    chatApiKey,
    scopeUserId,
    abortRef,
    firstTokenMetricsRef,
    sessionsRef,
    activeIdRef,
    updateSession,
    queueSessionPatch,
    queueMessageSync,
    flushSessionToServer,
    isPlaceholderSessionTitle,
    condenseTopicTitle,
  });

  const availableSkills = useMemo(
    () => chatSkillOptions(skills, skillCatalog),
    [skillCatalog, skills],
  );
  const frequentSkills = useMemo(() => {
    const ranked = [...availableSkills].sort(
      (a, b) => (skillCallCounts[b.name] ?? 0) - (skillCallCounts[a.name] ?? 0),
    );
    return ranked.slice(0, 3);
  }, [availableSkills, skillCallCounts]);

  useEffect(() => {
    if (frequentSkills.length === 0) return;
    console.info("[chat] 常用技能快捷", {
      skills: frequentSkills.map((skill) => skill.name),
      calls: frequentSkills.map((skill) => skillCallCounts[skill.name] ?? 0),
    });
  }, [frequentSkills, skillCallCounts]);

  const chooseCollection = useCallback((name: string) => {
    const next = name.trim();
    setSelectedCollection(next);
    setIncludeKnowledgeContext(true);
    setKbMenuOpen(false);
    console.info("[chat] 知识库选择", { mode: next ? "single" : "all", collection: next || null });
  }, []);
  const mentionedSkillNames = useMemo(
    () => extractMentionedSkillNames(input, availableSkills),
    [availableSkills, input],
  );
  const mentionCandidates = useMemo(
    () => (mentionOpen ? filterSkillMentions(availableSkills, mentionQuery) : []),
    [availableSkills, mentionOpen, mentionQuery],
  );

  const syncSkillMention = useCallback((value: string, cursor: number) => {
    if (availableSkills.length === 0) {
      setMentionOpen(false);
      return;
    }
    const before = value.slice(0, cursor);
    const atMatch = before.match(/@([^\s@]*)$/);
    if (!atMatch) {
      setMentionOpen(false);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(atMatch[1] ?? "");
    setMentionStart(cursor - (atMatch[0]?.length ?? 0));
    setMentionIndex(0);
  }, [availableSkills.length]);

  const insertSkillMention = useCallback((skill: ChatSkillOption, replaceActiveMention = false) => {
    const token = `@${skillMentionToken(skill)}`;
    if (!replaceActiveMention && input.includes(token)) {
      const next = input.replace(token, "").replace(/[ \t]{2,}/g, " ").replace(/^\s+/, "");
      setInput(next);
      setMentionOpen(false);
      console.info("[chat] 移除技能标记", { skill: skill.name, label: skill.label });
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? input.length;
    const start = replaceActiveMention && mentionStart >= 0 ? mentionStart : cursor;
    const end = replaceActiveMention ? cursor : (el?.selectionEnd ?? cursor);
    const before = input.slice(0, start);
    const after = input.slice(end);
    const needsGap = before.length > 0 && !/\s$/.test(before);
    const insertion = `${needsGap ? " " : ""}${token} `;
    const next = `${before}${insertion}${after}`;
    setInput(next);
    setMentionOpen(false);
    setMentionQuery("");
    console.info("[chat] 插入技能标记", { skill: skill.name, label: skill.label });
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      const pos = before.length + insertion.length;
      node.focus();
      node.setSelectionRange(pos, pos);
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 144)}px`;
    });
  }, [input, mentionStart]);

  const submitChat = useCallback(() => {
    const invoked = extractMentionedSkillNames(input, availableSkills);
    setMentionOpen(false);
    void sendMessage(undefined, invoked.length > 0 ? { invokedSkillNames: invoked } : undefined);
  }, [availableSkills, input, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = mentionCandidates[mentionIndex];
        if (picked) insertSkillMention(picked, true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  };

  const messagesEndRef = useAutoScroll(
    workspaceSession?.messages.map((m) => `${m.role}:${m.content}`).join("") ?? "",
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

  const projectBindingLocked = isChatConversationStarted(workspaceSession);
  const chatFileKey = includeFileContext && selectedFileId ? selectedFileId : null;
  const hasThread = Boolean(workspaceSession?.messages.length) || Boolean(error);
  const welcome = useMemo(() => {
    const projectName = projects.find((item) => item.id === boundProjectId)?.name?.trim() || "";
    const fileTitles = projectFiles
      .map((file) => file.title?.trim())
      .filter((title): title is string => Boolean(title));
    const selected = chatFileKey ? decodeProjectFileSelectValue(chatFileKey) : null;
    const selectedTitle = selected
      ? projectFiles.find((file) => file.kind === selected.kind && file.id === selected.id)?.title?.trim() || ""
      : "";

    if (!boundProjectId || !projectName) {
      return { title: "今天想完成什么？", files: [] as string[] };
    }
    if (projectFilesLoading && fileTitles.length === 0) {
      return { title: "正在读取项目文件", files: [] as string[] };
    }
    if (selectedTitle) {
      return { title: `围绕「${selectedTitle}」`, files: fileTitles };
    }
    if (fileTitles.length === 0) {
      return { title: `${projectName} 还没有文件`, files: [] as string[] };
    }
    return { title: `从 ${projectName} 的材料开始`, files: fileTitles };
  }, [boundProjectId, chatFileKey, projectFiles, projectFilesLoading, projects]);

  useEffect(() => {
    console.info("[chat] 欢迎语", {
      project_id: boundProjectId || null,
      files: projectFiles.length,
      loading: projectFilesLoading,
      title: welcome.title,
    });
  }, [boundProjectId, projectFiles.length, projectFilesLoading, welcome.title]);

  const taskGroups = useMemo(() => {
    const query = taskFilter.trim().toLowerCase();
    const match = (session: ChatSession) => {
      if (!query) return true;
      const title = titleFromSession(session).toLowerCase();
      const project = sessionProjectIdentifier(session, projects).toLowerCase();
      return title.includes(query) || project.includes(query);
    };
    const groups: { id: SessionHistoryCategory; label: string; sessions: ChatSession[] }[] = [
      { id: "chat", label: "对话", sessions: sessionsByCategory.chat.filter(match) },
      { id: "scenario", label: "场景", sessions: sessionsByCategory.scenario.filter(match) },
    ];
    return groups.filter((group) => group.sessions.length > 0 || (!query && group.id === "chat"));
  }, [projects, sessionsByCategory, taskFilter]);

  useEffect(() => {
    console.info("[chat] 工作台", {
      layout: hasThread ? "thread" : "composer",
      tasks: sessionsByCategory.chat.length + sessionsByCategory.scenario.length,
      files_rail: "auto-hide",
    });
  }, [hasThread, sessionsByCategory.chat.length, sessionsByCategory.scenario.length]);

  useEffect(() => {
    if (hasThread) return;
    inputRef.current?.focus();
  }, [activeId, hasThread]);

  const renderProjectFilesRail = (autoHide = false) => (
    <ProjectFilesRail
      scope="chat"
      autoHide={autoHide}
      projects={projects}
      projectId={boundProjectId}
      fileKey={chatFileKey}
      files={projectFiles}
      loading={projectFilesLoading}
      locked={projectBindingLocked}
      onProjectChange={(next) => {
        setSelectedProjectId(next);
        setIncludeProjectContext(Boolean(next));
        setIncludeFileContext(false);
        setSelectedFileId("");
      }}
      onFileChange={(next) => {
        setIncludeFileContext(Boolean(next));
        setSelectedFileId(next ?? "");
      }}
      onRefresh={() => setProjectFilesRefreshKey((value) => value + 1)}
    />
  );

  return (
    <>
    <div className="flex min-h-0 flex-1 overflow-hidden bg-[#f7f8f6] text-slate-900 dark:bg-slate-900 dark:text-white">
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-0"
        } flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-slate-200/90 bg-[#f3f4f1] transition-all dark:border-slate-700 dark:bg-slate-800`}
      >
        <div className="shrink-0 px-3 pb-2 pt-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">任务</span>
            <button
              type="button"
              onClick={() => createSession()}
              className="rounded-md px-2 py-1 text-xs text-slate-500 transition hover:bg-white hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
            >
              + 新对话
            </button>
          </div>
          <input
            value={taskFilter}
            onChange={(event) => {
              const next = event.target.value;
              setTaskFilter(next);
              console.info("[chat] 任务列表筛选", { query: next.trim() });
            }}
            placeholder="搜索任务"
            className="w-full rounded-lg border border-transparent bg-white/80 px-3 py-1.5 text-xs text-slate-800 outline-none placeholder:text-slate-400 focus:border-slate-300 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-slate-600"
          />
        </div>

        {sessionsLoading ? <p className="px-4 py-6 text-xs text-slate-500">加载任务…</p> : null}
        {sessionsSyncError ? (
          <p className="mx-3 mt-1 rounded-lg border border-amber-400/40 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            同步异常：{sessionsSyncError.slice(0, 80)}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {taskGroups.every((group) => group.sessions.length === 0) && !sessionsLoading ? (
            <p className="px-2 py-6 text-xs leading-relaxed text-slate-500">
              {taskFilter.trim() ? "没有匹配的任务。" : "还没有任务。点「+ 新对话」开始。"}
            </p>
          ) : null}
          {taskGroups.map((group) => (
            <section key={group.id} className="mb-3">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-[11px] font-medium text-slate-500">{group.label}</span>
                {group.id === "chat" ? (
                  <button
                    type="button"
                    aria-label="新建对话"
                    onClick={() => createSession()}
                    className="rounded px-1 text-sm leading-none text-slate-400 hover:bg-white hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-white"
                  >
                    +
                  </button>
                ) : null}
              </div>
              {group.sessions.map((session) => {
                const sessionTitle = titleFromSession(session);
                const active = session.id === activeId;
                return (
                  <div
                    key={session.id}
                    onClick={() => handleHistorySessionClick(session)}
                    className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 transition ${
                      active
                        ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                        : "text-slate-600 hover:bg-white/70 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700/60 dark:hover:text-white"
                    }`}
                  >
                    {sessionListIcon(session)}
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{sessionTitle}</span>
                      <span className="block truncate text-[10px] text-slate-400">
                        {sessionProjectIdentifier(session, projects)}
                      </span>
                    </div>
                    <button
                      type="button"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDeleteSession({ id: session.id, title: sessionTitle });
                      }}
                      className="text-xs text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                      aria-label={`删除对话：${sessionTitle}`}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header
            className={`flex shrink-0 items-center gap-3 px-4 py-3 ${
              hasThread ? "border-b border-slate-200/80 dark:border-slate-700" : ""
            }`}
          >
            <button
              onClick={() => setSidebarOpen((value) => !value)}
              className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white"
              aria-label={sidebarOpen ? "收起任务列表" : "展开任务列表"}
            >
              {sidebarOpen ? "◀" : "▶"}
            </button>
            <h1 className="min-w-0 flex-1 truncate text-sm text-slate-500">
              对话创作
              <span className="px-1.5 text-slate-300">/</span>
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {titleFromSession(workspaceSession)}
              </span>
            </h1>
            {employeeFromUrl ? (
              <button
                type="button"
                onClick={() => {
                  const params = new URLSearchParams(searchParams?.toString() || "");
                  params.delete("employee_id");
                  params.delete("run_id");
                  const query = params.toString();
                  console.info("[chat] 取消钉住员工", { employeeId: employeeFromUrl });
                  router.replace(query ? `/chat?${query}` : "/chat");
                }}
                className="shrink-0 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                已钉住员工 · 取消
              </button>
            ) : null}
            {(preparingContext || streaming) && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                {preparingContext ? "准备上下文" : "生成中"}
              </span>
            )}
          </header>
          <details className="group shrink-0 border-b border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-900/40 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-200 [&::-webkit-details-marker]:hidden">
              <span>项目文件</span>
              <span className="text-xs text-slate-500 group-open:hidden">展开</span>
              <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
            </summary>
            <div className="h-[42vh] min-h-0 border-t border-slate-300 dark:border-slate-700">
              {renderProjectFilesRail()}
            </div>
          </details>

          {hasThread ? (
          <ChatMessageStream
            activeSession={workspaceSession}
            streaming={streaming}
            preparingContext={preparingContext}
            streamingPhase={streamingPhase}
            effectiveKbCollection={effectiveKbCollection}
            includeProjectContext={includeProjectContext}
            selectedProjectId={selectedProjectId}
            projectFromUrl={projectFromUrl}
            activeId={activeId}
            scenarioFromUrl={scenarioFromUrl}
            selectedSourceOutputId={selectedSourceOutputId}
            onRegenerate={regenerateAssistantReply}
            onDocumentCreated={(outputId) => {
              const projectId = selectedProjectId || projectFromUrl;
              setIncludeProjectContext(true);
              setIncludeFileContext(true);
              setSelectedFileId(encodeProjectFileSelectValue("output", outputId));
              setProjectFilesRefreshKey((value) => value + 1);
              console.info("[chat] 文档已挂到项目文件", { output_id: outputId, project_id: projectId });
            }}
            titleFromSession={titleFromSession}
            error={error}
            messagesEndRef={messagesEndRef}
          />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
              <ContentCreationMark />
              <h2 className="mt-3 max-w-xl text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                {welcome.title}
              </h2>
              {frequentSkills.length > 0 ? (
                <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-2">
                  {frequentSkills.map((skill) => {
                    const token = `@${skillMentionToken(skill)}`;
                    const active = input.includes(token);
                    return (
                      <button
                        key={skill.name}
                        type="button"
                        title={skill.hint || skill.label}
                        onClick={() => {
                          if (!active) insertSkillMention(skill);
                          else inputRef.current?.focus();
                          console.info("[chat] 插入常用技能", { skill: skill.name, token });
                        }}
                        className={`max-w-[16rem] truncate rounded-full border px-3 py-1 text-xs transition ${
                          active
                            ? "border-blue-500 bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
                        }`}
                      >
                        {token}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {welcome.files.length > 0 ? (
                <div className="mt-4 flex max-w-xl flex-wrap justify-center gap-1.5">
                  {welcome.files.slice(0, 6).map((title) => (
                    <span
                      key={title}
                      className="max-w-[14rem] truncate rounded-full bg-white px-2.5 py-1 text-[11px] text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-300"
                    >
                      {title}
                    </span>
                  ))}
                  {welcome.files.length > 6 ? (
                    <span className="rounded-full px-2 py-1 text-[11px] text-slate-400">
                      还有 {welcome.files.length - 6} 份
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          <div className={hasThread ? "shrink-0 px-4 pb-4 pt-2" : "shrink-0 px-6 pb-8"}>
            {selectedProjectId &&
            chatMode === "co_create" &&
            (includeFileContext || selectedFileId) ? (
              <p className="mb-2 text-center text-xs text-indigo-700 dark:text-indigo-300">
                涉及项目文件改写时，建议在{" "}
                <Link
                  href={`/projects/${selectedProjectId}/co-create`}
                  className="font-medium underline"
                >
                  项目共创
                </Link>{" "}
                中继续，可获得文件 diff 与版本沉淀。
              </p>
            ) : null}
            {bootstrapWarnings.length > 0 ? (
              <p className="mb-2 text-center text-xs text-amber-700 dark:text-amber-300">
                {bootstrapWarnings.join("；")}
              </p>
            ) : null}
            {docOptimizeBindingHint ? (
              <p className="mb-2 text-center text-xs text-amber-700 dark:text-amber-300">
                {docOptimizeBindingHint}
              </p>
            ) : null}
            <div className="relative w-full rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
                {mentionOpen && mentionCandidates.length > 0 ? (
                  <div className="absolute bottom-full left-0 z-20 mb-1 max-h-52 w-full overflow-y-auto rounded-xl border border-slate-300 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-900">
                    {mentionCandidates.map((skill, index) => (
                      <button
                        key={skill.name}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertSkillMention(skill, true)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
                          index === mentionIndex
                            ? "bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                            : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                        }`}
                      >
                        <span className="shrink-0 font-medium">@{skill.label}</span>
                        {skill.hint ? (
                          <span className="truncate text-[10px] text-slate-400">{skill.hint}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  const next = e.target.value;
                  setInput(next);
                  syncSkillMention(next, e.target.selectionStart ?? next.length);
                }}
                onClick={(e) =>
                  syncSkillMention(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)
                }
                onKeyDown={handleKeyDown}
                onKeyUp={(e) => {
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
                    syncSkillMention(
                      e.currentTarget.value,
                      e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                    );
                  }
                }}
                placeholder={
                  docOptimizeBindingHint
                    ? "请先在右侧选择项目和要优化的文稿…"
                    : "输入问题开始对话，@ 调用技能，回车发送"
                }
                rows={hasThread ? 1 : 2}
                disabled={streaming || preparingContext}
                className="w-full resize-none bg-transparent px-4 pt-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-50 dark:text-white"
                style={{ maxHeight: "9rem", minHeight: hasThread ? "2.75rem" : "4.5rem", height: "auto" } as CSSProperties}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
                }}
              />
              <div className="flex items-center gap-2 px-3 pb-3">
                <div className="relative">
                  <button
                    type="button"
                    aria-expanded={skillsMenuOpen}
                    onClick={() => {
                      setKbMenuOpen(false);
                      setSkillsMenuOpen((open) => {
                        const next = !open;
                        console.info("[chat] 技能菜单", { open: next, count: availableSkills.length });
                        return next;
                      });
                    }}
                    className="rounded-full px-2.5 py-1 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-700 dark:hover:text-white"
                  >
                    技能{availableSkills.length > 0 ? ` ${availableSkills.length}` : ""}
                  </button>
                  {skillsMenuOpen ? (
                    <div className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-600 dark:bg-slate-900">
                      {availableSkills.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-slate-500">暂无已启用技能。</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {availableSkills.map((skill) => {
                            const active = mentionedSkillNames.includes(skill.name);
                            return (
                              <button
                                key={skill.name}
                                type="button"
                                title={skill.hint || skill.name}
                                onClick={() => insertSkillMention(skill)}
                                className={`max-w-full truncate rounded-full border px-2 py-1 text-[11px] transition ${
                                  active
                                    ? "border-blue-500 bg-blue-600/15 text-blue-800 dark:text-blue-200"
                                    : "border-slate-200 text-slate-600 hover:border-slate-400 dark:border-slate-600 dark:text-slate-300"
                                }`}
                              >
                                @{skill.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <Link href="/skills" className="mt-2 block px-1 text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-white">
                        技能工坊
                      </Link>
                    </div>
                  ) : null}
                </div>
                <div className="relative min-w-0">
                  <button
                    type="button"
                    aria-expanded={kbMenuOpen}
                    onClick={() => {
                      setSkillsMenuOpen(false);
                      setKbMenuOpen((open) => {
                        const next = !open;
                        console.info("[chat] 知识库菜单", {
                          open: next,
                          count: visibleCollections.length,
                          selected: selectedCollection || null,
                        });
                        return next;
                      });
                    }}
                    className="max-w-[12rem] truncate rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-800 transition hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-950/60"
                    title={
                      selectedCollection
                        ? kbCollectionLabel(selectedCollection)
                        : `默认检索全部知识库（${defaultKnowledgeCollections.length}）`
                    }
                  >
                    {selectedCollection ? kbCollectionLabel(selectedCollection) : "全部知识库"}
                  </button>
                  {kbMenuOpen ? (
                    <div className="absolute bottom-full left-0 z-20 mb-2 max-h-64 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-900">
                      <button
                        type="button"
                        onClick={() => chooseCollection("")}
                        className={`flex w-full px-3 py-2 text-left text-xs ${
                          !selectedCollection
                            ? "bg-slate-50 text-slate-900 dark:bg-slate-800 dark:text-white"
                            : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                        }`}
                      >
                        全部知识库{defaultKnowledgeCollections.length > 0 ? `（${defaultKnowledgeCollections.length}）` : ""}
                      </button>
                      {visibleCollections.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-slate-500">暂无可用知识库。</p>
                      ) : (
                        visibleCollections.map((name) => {
                          const active = selectedCollection === name;
                          const label = kbCollectionLabel(name);
                          return (
                            <button
                              key={name}
                              type="button"
                              title={kbCollectionDescription(name) || label}
                              onClick={() => chooseCollection(name)}
                              className={`flex w-full px-3 py-2 text-left text-xs ${
                                active
                                  ? "bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                                  : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                              }`}
                            >
                              <span className="truncate">{label}</span>
                            </button>
                          );
                        })
                      )}
                      <Link href="/knowledge" className="block px-3 py-2 text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-white">
                        打开知识库
                      </Link>
                    </div>
                  ) : null}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  {streaming ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (abortRef.current) abortRef.current.abort();
                        setStreaming(false);
                      }}
                      className="rounded-full px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      停止
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => submitChat()}
                    disabled={streaming || preparingContext || !input.trim() || !docOptimizeBindingReady}
                    aria-label="发送"
                    className={`flex h-9 w-9 items-center justify-center rounded-full text-sm transition ${
                      streaming || preparingContext || !input.trim() || !docOptimizeBindingReady
                        ? "cursor-not-allowed bg-slate-200 text-slate-400 dark:bg-slate-700"
                        : "bg-blue-600 text-white hover:bg-blue-500"
                    }`}
                  >
                    {preparingContext ? "…" : "↑"}
                  </button>
                </div>
              </div>
            </div>
            <p className="mt-2 text-center text-xs text-slate-400">AI 回复仅供参考，如有疑问请核实信息</p>
          </div>
        </div>

        <div className="hidden h-full min-h-0 lg:flex">{renderProjectFilesRail(true)}</div>
      </div>
    </div>
    <ConfirmDialog
      open={pendingDeleteSession !== null}
      title="删除对话"
      description={
        pendingDeleteSession
          ? `确定删除「${pendingDeleteSession.title}」？\n对话记录将被永久删除，无法恢复。`
          : ""
      }
      confirmLabel="删除"
      destructive
      onCancel={() => setPendingDeleteSession(null)}
      onConfirm={() => {
        if (pendingDeleteSession) deleteSession(pendingDeleteSession.id);
        setPendingDeleteSession(null);
      }}
    />
    </>
  );
}
