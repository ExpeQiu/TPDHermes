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

import { apiV1 } from "@/lib/api";
import {
  ALL_PROJECT_FILES_SELECT_VALUE,
  ChatInit,
  ChatMode,
  ChatTransportConfig,
  decodeProjectFileSelectValue,
  fetchChatBootstrap,
  fetchOrchestrationPreview,
  fetchProjectContext,
  fetchProjectFiles,
  getDocOptimizeBindingStatus,
  isAllProjectFilesSelection,
  ProjectFileListItem,
  ProjectRecord,
  type OrchestrationPreviewResponse,
  type ProjectContextResponse,
  type QuickCreateFlowOverrides,
} from "@/lib/chat-context";
import { inferSessionKind } from "@/lib/chat-sessions-api";
import { fetchRunKbSources } from "@/lib/chat-citations";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import type { ChatSession } from "@/app/chat/chat-types";
import { ChatMessageStream } from "@/app/chat/components/chat-message-stream";
import {
  ChatTaskBoundaryModel,
  ChatTaskBoundaryPanel,
} from "@/app/chat/components/chat-task-boundary-panel";
import { useChatExecution } from "@/app/chat/hooks/use-chat-execution";
import {
  sessionToPatchPayload,
  useChatSessionStore,
} from "@/app/chat/hooks/use-chat-session-store";

type FirstTokenMetrics = { count: number; totalMs: number };

const CHAT_INIT_KEY = "tphermes-chat-init";
const PLACEHOLDER_SESSION_TITLES = new Set(["新对话", "对话创作"]);

function useAutoScroll(depend: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [depend]);
  return ref;
}

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
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [transport, setTransport] = useState<ChatTransportConfig | null>(null);
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
  const [projectFiles, setProjectFiles] = useState<ProjectFileListItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
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
      localStorage.setItem(`tphermes-chat-active:${scopeUserId}`, targetId);
      setSidebarOpen(true);
    } else if (outputIdFromUrl) {
      setSidebarOpen(true);
    }
    chatDeepLinkAppliedRef.current = true;
  }, [outputIdFromUrl, scopeUserId, sessionIdFromUrl, sessions, setActiveId]);

  useEffect(() => {
    fetchChatBootstrap()
      .then((data) => {
        setProjects(data.projects);
        setCollections(data.collections);
        setSkills(data.skills);
        setTransport(data.transport);
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

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    const outputFiles = projectFiles.filter((file) => file.kind === "output");
    const attachmentFiles = projectFiles.filter((file) => file.kind === "attachment");
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
          ? projectFiles.find((item) => item.id === decoded.id && item.kind === decoded.kind)
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
      if (!binding.ready) parts.push(`待完成: ${binding.issues.join("；")}`);
    } else if (includeProjectContext && selectedProjectId) {
      const project = projects.find((item) => item.id === selectedProjectId);
      parts.push(`项目: ${project?.name ?? "已选"}`);
    }
    if (chatMode !== "doc_optimize") {
      if (isAllProjectFilesSelection(selectedFileId)) {
        parts.push(`文件: 全部（${outputFiles.length} 输出 + ${attachmentFiles.length} 附件）`);
      } else if (includeFileContext && selectedFileId) {
        const decoded = decodeProjectFileSelectValue(selectedFileId);
        const file = decoded
          ? projectFiles.find((item) => item.id === decoded.id && item.kind === decoded.kind)
          : null;
        parts.push(`文件: ${file?.title ?? "已选"}`);
      } else if (includeProjectContext && selectedProjectId) {
        parts.push("文件: 项目背景");
      }
    }
    if (includeKnowledgeContext && selectedCollection) {
      const knowledgeCollections = activeSession?.quickCreateOverrides?.knowledgeCollections;
      parts.push(
        knowledgeCollections && knowledgeCollections.length > 1
          ? `知识库: ${knowledgeCollections.length} 个（${knowledgeCollections.join("、")}）`
          : `知识库: ${selectedCollection}`,
      );
    }
    if (includeSkillsContext) {
      const skillNames = activeSession?.quickCreateOverrides?.skillNames;
      const skillCount = skillNames?.length ? skillNames.length : skills.length;
      parts.push(`技能: ${skillCount} 项`);
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
    includeKnowledgeContext,
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

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white transition hover:bg-blue-500"
          >
            + 新对话
          </button>
        </div>

        {sessionsLoading ? <p className="px-4 py-6 text-xs text-slate-500">加载历史记录…</p> : null}
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
              className={`group flex cursor-pointer items-center gap-2 border-b border-slate-300 px-4 py-3 transition dark:border-slate-700/50 ${
                session.id === activeId
                  ? "bg-slate-300/70 text-slate-900 dark:bg-slate-700/70 dark:text-white"
                  : "text-slate-400 hover:bg-slate-300/40 hover:text-slate-900 dark:bg-slate-700/40 dark:hover:text-white"
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
                className="text-xs text-slate-500 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
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
              onClick={() => setSidebarOpen((value) => !value)}
              className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white"
            >
              {sidebarOpen ? "◀" : "▶"}
            </button>
            <Link
              href="/"
              className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white"
            >
              ← 首页
            </Link>
            <h1 className="flex-1 truncate text-sm font-semibold text-slate-900 dark:text-white">
              {titleFromSession(activeSession)}
            </h1>
            {(preparingContext || streaming) && (
              <span className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
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
            <div className="max-h-[42vh] overflow-y-auto border-t border-slate-300 px-3 pb-3 pt-2 dark:border-slate-700/50">
              <ChatTaskBoundaryPanel model={boundaryModel} />
            </div>
          </details>

          <ChatMessageStream
            activeSession={activeSession}
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
            titleFromSession={titleFromSession}
            error={error}
            messagesEndRef={messagesEndRef}
          />

          <div className="shrink-0 border-t border-slate-300 bg-slate-200/60 py-4 dark:border-slate-700 dark:bg-slate-800/60">
            {docOptimizeBindingHint ? (
              <p className="mb-2 text-center text-xs text-amber-700 dark:text-amber-300">
                {docOptimizeBindingHint}
              </p>
            ) : null}
            <div className={`${CONTENT_MAX_CLASS} flex items-end gap-3 px-4 sm:px-6 md:px-8`}>
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
                className="flex-1 resize-none rounded-xl border border-slate-300 bg-slate-300/60 px-4 py-3 text-sm text-slate-900 transition placeholder-slate-400 focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700/60 dark:text-white dark:placeholder-slate-500"
                style={{ maxHeight: "9rem", minHeight: "3rem", height: "auto" } as CSSProperties}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
                }}
              />
              <button
                onClick={() => void sendMessage()}
                disabled={streaming || preparingContext || !input.trim() || !docOptimizeBindingReady}
                className={`flex-shrink-0 rounded-xl px-5 py-3 text-sm font-medium transition ${
                  streaming || preparingContext || !input.trim() || !docOptimizeBindingReady
                    ? "cursor-not-allowed bg-slate-300 text-slate-500 dark:bg-slate-700"
                    : "bg-blue-600 text-white hover:bg-blue-500"
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
                  className="flex-shrink-0 rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-700 transition hover:bg-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                >
                  停止
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-xs text-slate-600">AI 回复仅供参考，如有疑问请核实信息</p>
          </div>
        </div>

        <aside className="hidden h-full min-h-0 w-[min(22rem,32vw)] max-w-sm shrink-0 flex-col overflow-hidden border-l border-slate-300 bg-slate-200/40 dark:border-slate-700 dark:bg-slate-800/40 lg:flex">
          <div className="shrink-0 border-b border-slate-300 px-3 py-2 text-xs font-medium uppercase tracking-[0.16em] text-slate-500 dark:border-slate-700/80">
            创作边界
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <ChatTaskBoundaryPanel model={boundaryModel} />
          </div>
        </aside>
      </div>
    </div>
  );
}
