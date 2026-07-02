"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import { apiGet, apiV1 } from "@/lib/api";
import {
  buildCoCreateQuickStartPlan,
  type CoCreateQuickStartScenarioDetail,
} from "@/app/projects/[id]/co-create/co-create-quick-start";
import {
  buildCoCreateQuickEntries,
  type CoCreateQuickEntry,
} from "@/lib/co-create-quick-entries";
import {
  CO_CREATE_QUICK_SCENARIOS_CHANGED,
  coCreateQuickScenariosScopeId,
  loadCoCreateQuickScenariosPrefs,
  type CoCreateQuickScenariosPrefs,
} from "@/lib/co-create-quick-scenarios-prefs";
import {
  loadProjectQuickScenarios,
  quickScenariosScopeId,
} from "@/lib/project-quick-scenarios";
import {
  buildScenarioListItems,
  loadDismissedPresetIds,
  type ScenarioApiRow,
} from "@/lib/scenario-list";
import {
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  fetchChatBootstrap,
  fetchProjectContext,
  type ProjectContextResponse,
  type ProjectRecord,
} from "@/lib/chat-context";
import {
  applyFileAction,
  archiveProjectOutput,
  fetchProjectFileDetail,
  type ProjectFileItem,
  type ProjectFileVersionItem,
} from "@/lib/co-create-api";
import {
  isChatConversationStarted,
  isCoCreateSessionForProject,
  pickProjectCoCreateEntrySession,
  projectCoCreateSessionDefaults,
  titleFromSession,
} from "@/lib/chat-session-utils";
import { randomUUID } from "@/lib/random-id";
import { parseCoCreateNewCommand } from "@/app/projects/[id]/co-create/co-create-slash-commands";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import { ensureDerivedUserId } from "@/lib/user-id";
import type { Message } from "@/app/chat/chat-types";
import { useChatExecution } from "@/app/chat/hooks/use-chat-execution";
import {
  condenseTopicTitle as condenseFromStore,
  isPlaceholderSessionTitle as isPlaceholderFromStore,
  sessionToPatchPayload,
  useChatSessionStore,
} from "@/app/chat/hooks/use-chat-session-store";
import {
  composeUserMessageForApi,
  findActivePatchProposal,
  regionBlocksToExcerpts,
  type ContentRegionBlock,
  type CoCreateAgentMode,
  type CoCreateApplyMode,
  type CoCreatePipeline,
  type FileActionProposal,
  type FileRecommendation,
  type PatchEditMode,
  type SelectionToChatPayload,
} from "@/app/projects/[id]/co-create/co-create-types";
import {
  buildAgentModeInstructions,
  inferFileRecommendations,
  isPlanConfirmPrompt,
  parseAgentPlanFromContent,
  resolveExecutionFromAgentMode,
  type AgentPlan,
} from "@/app/projects/[id]/co-create/co-create-agent-utils";
import {
  CO_CREATE_ATTACHMENT_READONLY_ERROR,
  isCoCreateAttachmentFileKey,
  isCoCreateAttachmentPatchProposal,
  isCoCreateWritableFileKind,
  rejectCoCreateAttachmentPatchProposals,
} from "@/app/projects/[id]/co-create/co-create-file-policy";
import {
  type AgentUndoEntry,
  formatAgentUndoSummary,
  popAgentUndoStack,
  pushAgentUndoStack,
} from "@/app/projects/[id]/co-create/co-create-agent-undo";
import {
  buildRegionAwarePatchInstructions,
  resolvePatchAfterFromProposal,
} from "@/app/projects/[id]/co-create/co-create-partial-patch";
import { CoCreateWorkspaceColumns } from "@/app/projects/[id]/co-create/components/CoCreateWorkspaceColumns";
import { FilePreviewPanel } from "@/app/projects/[id]/co-create/components/FilePreviewPanel";
import { CoCreateComposer } from "@/app/projects/[id]/co-create/components/CoCreateComposer";
import { CoCreateMessageStream } from "@/app/projects/[id]/co-create/components/CoCreateMessageStream";
import { CoCreateTopbar } from "@/app/projects/[id]/co-create/components/CoCreateTopbar";
import type { ProjectContextLoadState } from "@/app/projects/[id]/co-create/components/ProjectContextBar";
import { FileCreateCard } from "@/app/projects/[id]/co-create/components/FileCreateCard";
import { UpdateToOutputDialog } from "@/app/projects/[id]/co-create/components/UpdateToOutputDialog";
import { FileDiffModal } from "@/app/projects/[id]/co-create/components/FileDiffModal";
import { FilePatchCard } from "@/app/projects/[id]/co-create/components/FilePatchCard";
import { FileRecommendationCard } from "@/app/projects/[id]/co-create/components/FileRecommendationCard";
import {
  fileKeyFromParams,
  ProjectFilesPanel,
} from "@/app/projects/[id]/co-create/components/ProjectFilesPanel";
import { SessionSidebar } from "@/app/projects/[id]/co-create/components/SessionSidebar";
import {
  autoPatchFallbackProposalId,
  buildRewriteSyncInstructions,
  extractAutoPatchBody,
  inferAutoPatchSummary,
  isAutoPatchFallbackProposal,
  isReadyForAutoPatch,
  isRewritePrompt,
  shouldAutoPatchFromAssistant,
  type AutoPatchTargetFile,
} from "@/app/projects/[id]/co-create/co-create-auto-patch";
import {
  autoCreateFallbackProposalId,
  buildDocumentSyncInstructions,
  extractAutoCreateDraftBody,
  findLatestTurnUserPrompt,
  inferAutoCreateDraftFileName,
  inferQuickCreateOutputFileName,
  isAutoCreateFallbackProposal,
  isDocumentGenerationPrompt,
  isReadyForAutoCreateDraft,
  isReadyForQuickStartAutoCreateDraft,
  shouldAutoCreateDraftFromAssistant,
  shouldQuickStartAutoCreateDraft,
} from "@/app/projects/[id]/co-create/co-create-auto-draft";
import {
  createProposalTargetKey,
  dedupeCreateProposals,
  hasActiveStreamFileActions,
  hasResolvedCreateForAssistant,
  isCreateProposalReadyForApply,
  isStreamFileActionProposal,
  mergeFileActionProposals,
  normalizeCreateFilePath,
  normalizeStreamCreateProposal,
  normalizeStreamPatchProposal,
  prunePendingCreatesForAssistantMessage,
  reconcileStreamCreateProposals,
  reconcileStreamPatchProposals,
  rejectSiblingCreateProposals,
  resolveCreateActionContent,
  selectVisibleCreateProposals,
  upsertFileActionProposal,
} from "@/app/projects/[id]/co-create/co-create-file-actions";
import { useFileWorkspace } from "@/app/projects/[id]/co-create/hooks/use-file-workspace";

function decodeFileIds(keys: string[]): string[] {
  return keys
    .map((k) => decodeProjectFileSelectValue(k)?.id)
    .filter((id): id is string => Boolean(id));
}

const CO_CREATE_FAST_QUERY_MAX_CHARS = 20;
const CO_CREATE_REWRITE_RE =
  /\/(生成新文件|改写当前文件)|修改|改写|重写|润色|增加|补充|加入|添加|创建|新建|保存|写入|覆盖|patch|diff|apply/i;
const CO_CREATE_FILE_TARGET_RE = /文件|文档|附件|输出物|版本|副本/i;
const CO_CREATE_PROJECT_HEAVY_RE = /当前项目|本项目|这个项目|项目内|项目中|基于项目/i;
const CO_CREATE_RESEARCH_RE =
  /研究|分析|深度|拆解|挖掘|对标|矩阵|趋势|策略|行业|市场|用户|竞品|报告/i;

function shouldUseCoCreateFastPath(options: {
  text: string;
  pinnedFileCount: number;
  roundFileCount: number;
  regionBlockCount: number;
}) {
  const compact = options.text.replace(/\s+/g, "");
  if (!compact) return false;
  if (isDocumentGenerationPrompt(options.text.trim())) return false;
  if (options.pinnedFileCount > 0 || options.roundFileCount > 0 || options.regionBlockCount > 0) {
    return false;
  }
  if (compact.length > CO_CREATE_FAST_QUERY_MAX_CHARS) return false;
  if (CO_CREATE_REWRITE_RE.test(compact) || CO_CREATE_FILE_TARGET_RE.test(compact)) return false;
  if (CO_CREATE_PROJECT_HEAVY_RE.test(compact)) return false;
  return true;
}

function resolveCoCreatePipeline(options: {
  text: string;
  pinnedFileCount: number;
  roundFileCount: number;
  regionBlockCount: number;
  hasPendingFileActions?: boolean;
}): CoCreatePipeline {
  const compact = options.text.replace(/\s+/g, "");
  if (options.hasPendingFileActions) return "rewrite";
  if (CO_CREATE_REWRITE_RE.test(compact)) return "rewrite";
  if (
    (options.roundFileCount > 0 || options.pinnedFileCount > 0) &&
    isRewritePrompt(options.text.trim(), { hasTargetFile: true })
  ) {
    return "rewrite";
  }
  if (isDocumentGenerationPrompt(options.text.trim())) return "co_create";
  if (shouldUseCoCreateFastPath(options)) return "fast";
  if (
    CO_CREATE_RESEARCH_RE.test(compact) ||
    CO_CREATE_PROJECT_HEAVY_RE.test(compact) ||
    compact.length > 40
  ) {
    return "research";
  }
  return "co_create";
}

function regionBlockFileName(
  files: ProjectFileItem[],
  fileKey: string,
  tabLabels: Record<string, string>,
): string {
  const decoded = decodeProjectFileSelectValue(fileKey);
  if (!decoded) return tabLabels[fileKey] ?? "文件";
  const file = files.find((f) => f.id === decoded.id && f.kind === decoded.kind);
  const pathName = file?.path?.split("/").filter(Boolean).pop();
  return pathName || file?.title || tabLabels[fileKey] || "文件";
}

function parsePatchEditMode(raw: unknown): PatchEditMode {
  const value = String(raw ?? "full");
  if (value === "search_replace" || value === "line_range" || value === "full") return value;
  return "full";
}

function parseOptionalInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function mapStreamActions(raw: Array<Record<string, unknown>>): FileActionProposal[] {
  const out: FileActionProposal[] = [];
  for (const item of raw) {
    const proposalId = String(item.proposal_id || item.proposalId || randomUUID());
    const type = String(item.type || "");
    if (type === "create") {
      const fileName = String(item.file_name || item.fileName || "新文件.md");
      out.push({
        type: "create",
        proposalId,
        fileName,
        path: normalizeCreateFilePath(fileName, String(item.path || "/")),
        content: String(item.content || ""),
        status: "proposed",
      });
    } else if (type === "patch") {
      const editMode = parsePatchEditMode(item.edit_mode ?? item.editMode);
      const oldString = String(item.old_string ?? item.oldString ?? "");
      const newString = String(item.new_string ?? item.newString ?? "");
      const newText = String(item.new_text ?? item.newText ?? "");
      const startLine = parseOptionalInt(item.start_line ?? item.startLine);
      const endLine = parseOptionalInt(item.end_line ?? item.endLine);
      let after = String(item.after || item.content || "");
      if (!after && editMode === "search_replace") after = newString;
      if (!after && editMode === "line_range") after = newText;
      out.push({
        type: "patch",
        proposalId,
        fileId: String(item.file_id || item.fileId || ""),
        fileKind: (item.file_kind || item.fileKind || "output") as "output" | "attachment",
        fileName: String(item.file_name || item.fileName || "文件"),
        summary: String(item.summary || "文件修改"),
        before: String(item.before || ""),
        after,
        status: "proposed",
        editMode,
        oldString: oldString || undefined,
        newString: newString || undefined,
        replaceAll: Boolean(item.replace_all ?? item.replaceAll),
        startLine,
        endLine,
        newText: newText || undefined,
      });
    }
  }
  return out;
}

function resolveAutoPatchTargetFile(
  pinnedFileKeys: string[],
  roundFileKeys: string[],
  files: ProjectFileItem[],
  tabLabels: Record<string, string>,
): AutoPatchTargetFile | null {
  for (const fileKey of [...roundFileKeys, ...pinnedFileKeys]) {
    const decoded = decodeProjectFileSelectValue(fileKey);
    if (!decoded || !isCoCreateWritableFileKind(decoded.kind)) continue;
    return {
      fileKey,
      fileId: decoded.id,
      fileKind: decoded.kind,
      fileName: regionBlockFileName(files, fileKey, tabLabels),
    };
  }
  return null;
}

async function resolveFileBeforeContent(
  projectId: string,
  target: AutoPatchTargetFile,
  activeFileKey: string | null,
  previewContent: string | undefined,
): Promise<string> {
  if (activeFileKey === target.fileKey && previewContent?.trim()) {
    return previewContent;
  }
  const detail = await fetchProjectFileDetail(projectId, target.fileId, target.fileKind);
  return detail.content ?? "";
}

function updateProposalStatus(
  proposalId: string,
  status: FileActionProposal["status"],
  actions: FileActionProposal[],
  patch?: { applyError?: string },
): FileActionProposal[] {
  return actions.map((proposal) => {
    if (proposal.proposalId !== proposalId) return proposal;
    return { ...proposal, status, ...patch };
  });
}

function findAssistantContentForProposal(
  session: { messages: Message[] } | undefined,
  proposalId: string,
): string {
  if (!session) return "";
  const hostMessage = session.messages.find((message) =>
    message.fileActions?.some((fa) => fa.proposalId === proposalId),
  );
  return hostMessage?.content ?? "";
}

export default function CoCreatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          加载项目共创…
        </div>
      }
    >
      <CoCreatePageInner />
    </Suspense>
  );
}

function CoCreatePageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = String(params?.id ?? "");
  const scopeUserId = useEffectiveUserScopeId();

  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [projectLoadState, setProjectLoadState] = useState<ProjectContextLoadState>("loading");
  const [projectContext, setProjectContext] = useState<ProjectContextResponse | null>(null);
  const [projectContextLoadState, setProjectContextLoadState] =
    useState<ProjectContextLoadState>("loading");
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [regionBlocks, setRegionBlocks] = useState<ContentRegionBlock[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [preparingContext, setPreparingContext] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState("");
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [filesPanelOpen, setFilesPanelOpen] = useState(true);
  const [previewMaximized, setPreviewMaximized] = useState(false);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error" | "pending_apply"
  >("idle");
  const [pendingActions, setPendingActions] = useState<FileActionProposal[]>([]);
  const [recommendations, setRecommendations] = useState<FileRecommendation[]>([]);
  const [diffProposal, setDiffProposal] = useState<Extract<FileActionProposal, { type: "patch" }> | null>(
    null,
  );
  const [updateToCreateProposal, setUpdateToCreateProposal] = useState<
    Extract<FileActionProposal, { type: "create" }> | null
  >(null);
  const [fileSaving, setFileSaving] = useState(false);
  const [undoingAgentChange, setUndoingAgentChange] = useState(false);
  const [remoteScenarios, setRemoteScenarios] = useState<ScenarioApiRow[]>([]);
  const [quickScenariosLoading, setQuickScenariosLoading] = useState(true);
  const [dismissedPresetIds] = useState(loadDismissedPresetIds);
  const [globalCoCreateQuickPrefs, setGlobalCoCreateQuickPrefs] =
    useState<CoCreateQuickScenariosPrefs>({ scenarioIds: [] });

  const abortRef = useRef<AbortController | null>(null);
  const firstTokenMetricsRef = useRef({ count: 0, totalMs: 0 });
  const entryAppliedRef = useRef(false);
  const entryProjectIdRef = useRef<string | null>(null);
  const autoApplyingProposalIdsRef = useRef<Set<string>>(new Set());
  const autoApplyingBusyRef = useRef(false);
  const autoDraftExtractedLenRef = useRef<Map<string, number>>(new Map());
  const pendingAutoDraftPromptRef = useRef<string | null>(null);
  const pendingQuickEntryTitleRef = useRef<string | null>(null);
  const autoPatchExtractedLenRef = useRef<Map<string, number>>(new Map());
  const pendingAutoPatchPromptRef = useRef<string | null>(null);
  const pendingAutoPatchTargetRef = useRef<AutoPatchTargetFile | null>(null);

  const fileWorkspace = useFileWorkspace(projectId);

  const handleSelectPreview = useCallback(
    (fileKey: string | null) => {
      fileWorkspace.openFileTab(fileKey);
    },
    [fileWorkspace],
  );

  const resetTransient = useCallback(() => {
    setError("");
    setPendingActions([]);
    setRecommendations([]);
  }, []);

  const resetComposerContext = useCallback(() => {
    setInput("");
    setRegionBlocks([]);
    setDiffProposal(null);
    pendingAutoDraftPromptRef.current = null;
    pendingAutoPatchPromptRef.current = null;
    pendingAutoPatchTargetRef.current = null;
    pendingQuickEntryTitleRef.current = null;
    autoDraftExtractedLenRef.current.clear();
    autoPatchExtractedLenRef.current.clear();
  }, []);

  const {
    sessions,
    activeId,
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
    defaultCollection: "",
    storageNamespace: "co-create",
    onResetTransientState: resetTransient,
  });

  const pinnedFileIds = activeSession?.pinnedFileIds ?? [];
  const roundFileIds = activeSession?.roundFileIds ?? [];
  const agentMode: CoCreateAgentMode = activeSession?.coCreateAgentMode ?? "agent";
  const applyMode: CoCreateApplyMode = activeSession?.coCreateApplyMode ?? "auto";
  const planPhase = activeSession?.coCreatePlanPhase ?? "idle";
  const agentUndoStack = activeSession?.agentUndoStack ?? [];

  const latestConfirmedPlan = useMemo((): AgentPlan | null => {
    const messages = activeSession?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      return (
        message.agentPlan ?? parseAgentPlanFromContent(message.content)
      );
    }
    return null;
  }, [activeSession?.messages]);

  useEffect(() => {
    if (streaming || preparingContext || agentMode !== "plan" || !activeId) return;
    const phase = activeSession?.coCreatePlanPhase ?? "idle";
    if (phase === "executing") return;

    const messages = activeSession?.messages ?? [];
    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!latestAssistant?.content.trim()) return;

    const plan = latestAssistant.agentPlan ?? parseAgentPlanFromContent(latestAssistant.content);
    if (!plan) return;

    const needsPlanAttach = !latestAssistant.agentPlan;
    const needsPhase = phase !== "awaiting_confirm";

    if (!needsPlanAttach && !needsPhase) return;

    updateSession(activeId, (session) => ({
      ...session,
      coCreatePlanPhase: "awaiting_confirm",
      messages: session.messages.map((message) =>
        message.id === latestAssistant.id
          ? { ...message, agentPlan: plan }
          : message,
      ),
    }));
    const updated = sessionsRef.current.find((session) => session.id === activeId);
    if (updated) queueSessionPatch(activeId, sessionToPatchPayload(updated));
    console.info("[co-create] Plan 计划已就绪，等待确认", { stepCount: plan.steps.length });
  }, [
    activeId,
    activeSession?.coCreatePlanPhase,
    activeSession?.messages,
    agentMode,
    preparingContext,
    queueSessionPatch,
    sessionsRef,
    streaming,
    updateSession,
  ]);

  const persistPlanPhase = useCallback(
    (phase: import("@/app/projects/[id]/co-create/co-create-agent-utils").CoCreatePlanPhase) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        coCreatePlanPhase: phase,
      }));
      const updated = sessionsRef.current.find((session) => session.id === activeSession.id);
      if (updated) queueSessionPatch(activeSession.id, sessionToPatchPayload(updated));
    },
    [activeSession, queueSessionPatch, sessionsRef, updateSession],
  );

  const appendAgentUndoEntry = useCallback(
    (entry: AgentUndoEntry) => {
      const sessionId = activeIdRef.current;
      if (!sessionId) return;
      updateSession(sessionId, (session) => ({
        ...session,
        agentUndoStack: pushAgentUndoStack(session.agentUndoStack ?? [], entry),
      }));
      const updated = sessionsRef.current.find((session) => session.id === sessionId);
      if (updated) {
        queueSessionPatch(sessionId, sessionToPatchPayload(updated));
      }
      console.info("[co-create] undo 栈已追加", {
        sessionId,
        proposalId: entry.proposalId,
        depth: updated?.agentUndoStack?.length ?? 0,
      });
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const appendTouchedFileId = useCallback(
    (fileKey: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId || !fileKey) return;
      updateSession(sessionId, (session) => ({
        ...session,
        touchedFileIds: [...new Set([...(session.touchedFileIds ?? []), fileKey])],
      }));
      const updated = sessionsRef.current.find((session) => session.id === sessionId);
      if (updated) {
        queueSessionPatch(sessionId, sessionToPatchPayload(updated));
      }
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const persistFileRefs = useCallback(
    (nextPinned: string[], nextRound: string[]) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (s) => ({
        ...s,
        pinnedFileIds: nextPinned,
        roundFileIds: nextRound,
      }));
      const updated = sessionsRef.current.find((s) => s.id === activeSession.id);
      if (updated) queueSessionPatch(activeSession.id, sessionToPatchPayload(updated));
    },
    [activeSession, queueSessionPatch, sessionsRef, updateSession],
  );

  const addToRound = useCallback(
    (fileKey: string) => {
      if (roundFileIds.includes(fileKey)) return;
      persistFileRefs(pinnedFileIds, [...roundFileIds, fileKey]);
    },
    [persistFileRefs, pinnedFileIds, roundFileIds],
  );

  const pinFile = useCallback(
    (fileKey: string) => {
      const nextPinned = pinnedFileIds.includes(fileKey)
        ? pinnedFileIds
        : [...pinnedFileIds, fileKey];
      persistFileRefs(nextPinned, roundFileIds);
    },
    [persistFileRefs, pinnedFileIds, roundFileIds],
  );

  const removeFileRef = useCallback(
    (fileKey: string, scope: "pinned" | "round") => {
      if (scope === "pinned") {
        persistFileRefs(
          pinnedFileIds.filter((k) => k !== fileKey),
          roundFileIds,
        );
      } else {
        persistFileRefs(
          pinnedFileIds,
          roundFileIds.filter((k) => k !== fileKey),
        );
      }
    },
    [persistFileRefs, pinnedFileIds, roundFileIds],
  );

  useEffect(() => {
    if (!projectId) return;
    setProjectLoadState("loading");
    setProjectContextLoadState("loading");
    setProject(null);
    setProjectContext(null);

    apiGet<ProjectRecord>(`/projects/${projectId}`)
      .then((data) => {
        setProject(data);
        setProjectLoadState("ready");
      })
      .catch((err) => {
        console.warn("[co-create] 项目详情加载失败", { projectId, err });
        setProject(null);
        setProjectLoadState("error");
      });

    fetchProjectContext(projectId)
      .then((data) => {
        setProjectContext(data);
        setProjectContextLoadState("ready");
      })
      .catch((err) => {
        console.warn("[co-create] 项目上下文加载失败", { projectId, err });
        setProjectContext(null);
        setProjectContextLoadState("error");
      });

    fetchChatBootstrap()
      .then((data) => {
        setCollections(data.collections);
        setSkills(data.skills);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setQuickScenariosLoading(true);
    apiGet<ScenarioApiRow[]>("/scenarios/")
      .then((rows) => {
        if (!cancelled) setRemoteScenarios(rows);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[co-create] 场景列表加载失败", err);
        }
        if (!cancelled) setRemoteScenarios([]);
      })
      .finally(() => {
        if (!cancelled) setQuickScenariosLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const loadPrefs = () => {
      setGlobalCoCreateQuickPrefs(loadCoCreateQuickScenariosPrefs(coCreateQuickScenariosScopeId()));
    };
    loadPrefs();
    window.addEventListener(CO_CREATE_QUICK_SCENARIOS_CHANGED, loadPrefs);
    window.addEventListener("focus", loadPrefs);
    return () => {
      window.removeEventListener(CO_CREATE_QUICK_SCENARIOS_CHANGED, loadPrefs);
      window.removeEventListener("focus", loadPrefs);
    };
  }, [scopeUserId]);

  const scenarioListItems = useMemo(
    () => buildScenarioListItems(remoteScenarios, dismissedPresetIds),
    [remoteScenarios, dismissedPresetIds],
  );

  const projectQuickScenarios = useMemo(
    () => loadProjectQuickScenarios(quickScenariosScopeId(), projectId),
    [projectId, scopeUserId],
  );

  const coCreateQuickEntries = useMemo(
    () =>
      buildCoCreateQuickEntries(scenarioListItems, {
        globalQuickPrefs: globalCoCreateQuickPrefs,
        projectQuickPrefs: projectQuickScenarios,
      }),
    [scenarioListItems, globalCoCreateQuickPrefs, projectQuickScenarios],
  );

  const coCreateMoreHref = useMemo(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("return_project_id", projectId);
    const qs = params.toString();
    return qs ? `/create?${qs}` : "/create";
  }, [projectId]);

  const outputFiles = useMemo(
    () => fileWorkspace.files.filter((file) => file.kind === "output"),
    [fileWorkspace.files],
  );
  const existingOutputTitles = useMemo(
    () => outputFiles.map((file) => file.title),
    [outputFiles],
  );

  useEffect(() => {
    if (!isCoCreateSessionForProject(activeSession, projectId)) return;
    if (!activeSession?.messages.some((message) => message.role === "user")) return;
    if (activeSession.titleManuallySet) return;
    const nextTitle = titleFromSession(activeSession, "新共创");
    if (isPlaceholderFromStore(nextTitle) || nextTitle === activeSession.title) return;
    updateSession(activeSession.id, (session) => ({ ...session, title: nextTitle }));
    const updated = sessionsRef.current.find((item) => item.id === activeSession.id);
    if (updated) queueSessionPatch(activeSession.id, { title: updated.title });
  }, [activeSession, projectId, queueSessionPatch, sessionsRef, updateSession]);

  useEffect(() => {
    entryAppliedRef.current = false;
    entryProjectIdRef.current = null;
  }, [projectId]);

  const visibleMessages = useMemo(() => {
    if (!isCoCreateSessionForProject(activeSession, projectId)) return [];
    return activeSession?.messages ?? [];
  }, [activeSession, projectId]);

  useEffect(() => {
    if (sessionsLoading || !projectId || !scopeUserId) return;
    if (entryAppliedRef.current && entryProjectIdRef.current === projectId) return;

    const sessionIdFromUrl = searchParams?.get("session_id");
    if (sessionIdFromUrl && sessions.some((s) => s.id === sessionIdFromUrl)) {
      selectSession(sessionIdFromUrl);
      entryAppliedRef.current = true;
      entryProjectIdRef.current = projectId;
      return;
    }

    const outputId = searchParams?.get("output_id");
    const fileId = searchParams?.get("file_id");
    const initialKey = fileKeyFromParams(outputId, fileId, "output");
    const projectSessions = sessions.filter(
      (s) =>
        !s.archived &&
        s.selectedProjectId === projectId &&
        s.sessionKind === "project_co_create",
    );
    const hasProjectSession = projectSessions.length > 0;

    if (!hasProjectSession) {
      const defaults = projectCoCreateSessionDefaults(projectId);
      if (initialKey) {
        defaults.roundFileIds = [initialKey];
        defaults.pinnedFileIds = [];
      }
      // 首次进入项目共创：等同点击「+ 新建」，不复用 orphan（避免 hydrate 出其他项目历史）
      resetComposerContext();
      resetTransient();
      fileWorkspace.resetWorkspace();
      createSession(defaults);
      if (initialKey) {
        fileWorkspace.openFileTab(initialKey);
      }
      console.info("[co-create] 项目首次进入，已新建共创会话", { projectId });
    } else {
      const target = pickProjectCoCreateEntrySession(sessions, projectId, activeSession);
      if (target && target.id !== activeId) {
        selectSession(target.id);
        console.info("[co-create] 已对齐到项目共创会话", {
          projectId,
          sessionId: target.id,
          empty: !isChatConversationStarted(target),
        });
      }
      if (initialKey && target) {
        const nextRound = [...new Set([...(target.roundFileIds ?? []), initialKey])];
        updateSession(target.id, (session) => ({
          ...session,
          roundFileIds: nextRound,
        }));
        const updated = sessionsRef.current.find((session) => session.id === target.id);
        if (updated) queueSessionPatch(target.id, sessionToPatchPayload(updated));
        fileWorkspace.openFileTab(initialKey);
      }
    }

    entryAppliedRef.current = true;
    entryProjectIdRef.current = projectId;
  }, [
    activeId,
    activeSession,
    createSession,
    fileWorkspace,
    projectId,
    queueSessionPatch,
    resetComposerContext,
    resetTransient,
    scopeUserId,
    searchParams,
    selectSession,
    sessions,
    sessionsLoading,
    sessionsRef,
    updateSession,
  ]);

  useEffect(() => {
    if (!activeSession) return;
    if (sessionsSyncError || pendingActions.some((a) => a.status === "failed")) {
      setSaveState("error");
    } else if (
      streaming ||
      fileSaving ||
      undoingAgentChange ||
      pendingActions.some((a) => a.status === "applying" || a.status === "proposed")
    ) {
      setSaveState("saving");
    } else if (agentUndoStack.length > 0) {
      setSaveState("saved");
    } else if (pendingActions.some((a) => a.status === "rejected")) {
      setSaveState("idle");
    } else if (pendingActions.length === 0 && !streaming) {
      setSaveState("saved");
    } else if (sessionsSyncError) {
      setSaveState("error");
    } else {
      setSaveState("saved");
    }
  }, [activeSession, agentUndoStack.length, fileSaving, pendingActions, sessionsSyncError, streaming, undoingAgentChange]);

  const syncProposalStatusToSession = useCallback(
    (
      proposalId: string,
      status: FileActionProposal["status"],
      removePending = false,
      patch?: { applyError?: string },
    ) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        pendingProposalIds: removePending
          ? (session.pendingProposalIds ?? []).filter((id) => id !== proposalId)
          : session.pendingProposalIds,
        messages: session.messages.map((message) =>
          message.fileActions?.length
            ? {
                ...message,
                fileActions: updateProposalStatus(proposalId, status, message.fileActions, patch),
              }
            : message,
        ),
      }));
    },
    [activeSession, updateSession],
  );

  const handleFileActionsFromStream = useCallback(
    (sessionId: string, assistantId: string, raw: Array<Record<string, unknown>>) => {
      const assistantMessage = sessionsRef.current
        .find((s) => s.id === sessionId)
        ?.messages.find((m) => m.id === assistantId);
      const assistantContent = assistantMessage?.content ?? "";
      const mapped = mapStreamActions(raw).map((proposal) =>
        proposal.type === "create"
          ? normalizeStreamCreateProposal(
              proposal,
              assistantContent,
              extractAutoCreateDraftBody,
              existingOutputTitles,
            )
          : normalizeStreamPatchProposal(
              proposal,
              assistantContent,
              proposal.before ?? "",
              extractAutoPatchBody,
            ),
      );
      if (mapped.length === 0) return;
      const mergedForAssistant = rejectCoCreateAttachmentPatchProposals(dedupeCreateProposals(mapped));
      if (
        mergedForAssistant.some(
          (item) => isCoCreateAttachmentPatchProposal(item) && item.status === "rejected",
        )
      ) {
        console.warn("[co-create] 已拒绝 attachment patch，请改写入 /输出/", {
          sessionId,
          assistantId,
        });
      }
      setPendingActions((prev) => {
        const pruned = prunePendingCreatesForAssistantMessage(prev, assistantId, mergedForAssistant);
        let next = pruned;
        for (const proposal of mergedForAssistant) {
          if (proposal.status === "rejected") continue;
          next = upsertFileActionProposal(next, proposal);
        }
        return dedupeCreateProposals(next);
      });
      updateSession(sessionId, (session) => ({
        ...session,
        pendingProposalIds: [
          ...new Set([
            ...(session.pendingProposalIds ?? []),
            ...mergedForAssistant
              .filter((item) => item.status !== "rejected")
              .map((m) => m.proposalId),
          ]),
        ],
        messages: session.messages.map((m) => {
          if (m.id !== assistantId) return m;
          const keptPatches = (m.fileActions ?? []).filter((item) => item.type === "patch");
          return {
            ...m,
            fileActions: dedupeCreateProposals([...keptPatches, ...mergedForAssistant]),
          };
        }),
      }));
      const updated = sessionsRef.current.find((s) => s.id === sessionId);
      if (updated) queueSessionPatch(sessionId, sessionToPatchPayload(updated));
    },
    [existingOutputTitles, queueSessionPatch, sessionsRef, updateSession],
  );

  const enqueueAutoCreateDraftForAssistant = useCallback(
    (sessionId: string, assistantMessage: Message | undefined, prompt: string) => {
      if (!assistantMessage || assistantMessage.role !== "assistant") return false;

      if (hasResolvedCreateForAssistant(assistantMessage.fileActions)) {
        return false;
      }

      const streamFileActions = assistantMessage.fileActions?.filter((item) =>
        isStreamFileActionProposal(item.proposalId),
      );
      if (hasActiveStreamFileActions(streamFileActions)) {
        return false;
      }

      const quickEntryTitle = pendingQuickEntryTitleRef.current?.trim() || "";
      const useQuickStart = Boolean(quickEntryTitle);

      const extracted = extractAutoCreateDraftBody(assistantMessage.content);
      const readyForDraft = useQuickStart
        ? isReadyForQuickStartAutoCreateDraft(extracted, assistantMessage.content)
        : isReadyForAutoCreateDraft(extracted, assistantMessage.content);
      const shouldCreate = useQuickStart
        ? shouldQuickStartAutoCreateDraft(
            quickEntryTitle,
            prompt,
            assistantMessage.content,
            false,
          )
        : shouldAutoCreateDraftFromAssistant(prompt, assistantMessage.content, false);

      if (!shouldCreate || !readyForDraft) {
        return false;
      }

      const prevLen = autoDraftExtractedLenRef.current.get(assistantMessage.id) ?? 0;
      if (extracted.length < prevLen + 80) return false;

      const proposalId = autoCreateFallbackProposalId(assistantMessage.id);
      const existing = assistantMessage.fileActions?.find(
        (item) => item.proposalId === proposalId && item.type === "create",
      );
      if (existing?.status === "applied" || existing?.status === "applying") return false;

      const fileName = useQuickStart
        ? inferQuickCreateOutputFileName(
            quickEntryTitle,
            prompt,
            assistantMessage.content,
            existingOutputTitles,
          )
        : inferAutoCreateDraftFileName(prompt, assistantMessage.content, existingOutputTitles);
      const proposal: FileActionProposal = {
        type: "create",
        proposalId,
        fileName,
        path: `/输出/${fileName}`,
        content: extracted,
        status: "proposed",
      };

      autoDraftExtractedLenRef.current.set(assistantMessage.id, extracted.length);
      if (existing && existing.type === "create" && existing.content !== extracted) {
        autoApplyingProposalIdsRef.current.delete(proposalId);
      }
      if (existing?.status === "failed") {
        autoApplyingProposalIdsRef.current.delete(proposalId);
      }

      setPendingActions((prev) => {
        const others = prev.filter((item) => item.proposalId !== proposalId);
        return [...others, proposal];
      });
      updateSession(sessionId, (session) => ({
        ...session,
        pendingProposalIds: [
          ...new Set([...(session.pendingProposalIds ?? []), proposal.proposalId]),
        ],
        messages: session.messages.map((message) => {
          if (message.id !== assistantMessage.id) return message;
          const rest = (message.fileActions ?? []).filter(
            (item) => item.proposalId !== proposalId,
          );
          return {
            ...message,
            fileActions: dedupeCreateProposals([...rest, proposal]),
          };
        }),
      }));
      const updated = sessionsRef.current.find((s) => s.id === sessionId);
      if (updated) queueSessionPatch(sessionId, sessionToPatchPayload(updated));
      console.info("[co-create] 自动建稿提案已更新", {
        sessionId,
        assistantId: assistantMessage.id,
        fileName,
        quickEntryTitle: quickEntryTitle || undefined,
        contentLength: extracted.length,
        updated: Boolean(existing),
      });
      return true;
    },
    [existingOutputTitles, queueSessionPatch, sessionsRef, updateSession],
  );

  const maybeAutoCreateDraftFromLatestAssistant = useCallback(
    (fallbackPrompt?: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId) return false;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return false;
      const latestAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      const prompt =
        findLatestTurnUserPrompt(session.messages) || fallbackPrompt?.trim() || "";
      if (!prompt) return false;
      return enqueueAutoCreateDraftForAssistant(sessionId, latestAssistant, prompt);
    },
    [activeIdRef, enqueueAutoCreateDraftForAssistant, sessionsRef],
  );

  const enqueueAutoPatchForAssistant = useCallback(
    (
      sessionId: string,
      assistantMessage: Message | undefined,
      prompt: string,
      beforeContent: string,
      target: AutoPatchTargetFile,
    ) => {
      if (!assistantMessage || assistantMessage.role !== "assistant") return false;
      if (!isCoCreateWritableFileKind(target.fileKind)) {
        console.info("[co-create] 跳过附件自动改写", { fileName: target.fileName });
        return false;
      }

      const streamFileActions = assistantMessage.fileActions?.filter((item) =>
        isStreamFileActionProposal(item.proposalId),
      );
      if (hasActiveStreamFileActions(streamFileActions)) {
        return false;
      }

      const extracted = extractAutoPatchBody(assistantMessage.content);
      if (
        !shouldAutoPatchFromAssistant(prompt, assistantMessage.content, beforeContent, false) ||
        !isReadyForAutoPatch(extracted, beforeContent, assistantMessage.content)
      ) {
        return false;
      }

      const prevLen = autoPatchExtractedLenRef.current.get(assistantMessage.id) ?? 0;
      if (extracted.length < prevLen + 80) return false;

      const proposalId = autoPatchFallbackProposalId(assistantMessage.id);
      const existing = assistantMessage.fileActions?.find(
        (item) => item.proposalId === proposalId && item.type === "patch",
      );
      if (existing?.status === "applied" || existing?.status === "applying") return false;

      const proposal: FileActionProposal = {
        type: "patch",
        proposalId,
        fileId: target.fileId,
        fileKind: target.fileKind,
        fileName: target.fileName,
        before: beforeContent,
        after: extracted,
        editMode: "full",
        summary: inferAutoPatchSummary(prompt),
        status: "proposed",
      };

      autoPatchExtractedLenRef.current.set(assistantMessage.id, extracted.length);
      if (existing && existing.type === "patch" && existing.after !== extracted) {
        autoApplyingProposalIdsRef.current.delete(proposalId);
      }
      if (existing?.status === "failed") {
        autoApplyingProposalIdsRef.current.delete(proposalId);
      }

      setPendingActions((prev) => {
        const others = prev.filter((item) => item.proposalId !== proposalId);
        return [...others, proposal];
      });
      updateSession(sessionId, (session) => ({
        ...session,
        pendingProposalIds: [
          ...new Set([...(session.pendingProposalIds ?? []), proposal.proposalId]),
        ],
        messages: session.messages.map((message) => {
          if (message.id !== assistantMessage.id) return message;
          const rest = (message.fileActions ?? []).filter(
            (item) => item.proposalId !== proposalId,
          );
          return { ...message, fileActions: [...rest, proposal] };
        }),
      }));
      const updated = sessionsRef.current.find((s) => s.id === sessionId);
      if (updated) queueSessionPatch(sessionId, sessionToPatchPayload(updated));
      console.info("[co-create] 自动改写提案已更新", {
        sessionId,
        assistantId: assistantMessage.id,
        fileName: target.fileName,
        afterLength: extracted.length,
        beforeLength: beforeContent.length,
        updated: Boolean(existing),
      });
      return true;
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const maybeAutoPatchFromLatestAssistant = useCallback(
    async (fallbackPrompt: string, target: AutoPatchTargetFile) => {
      const sessionId = activeIdRef.current;
      if (!sessionId) return false;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return false;
      const latestAssistant = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const prompt = findLatestTurnUserPrompt(session.messages) || fallbackPrompt.trim() || "";
      if (!prompt) return false;
      const before = await resolveFileBeforeContent(
        projectId,
        target,
        fileWorkspace.activeFileKey,
        fileWorkspace.previewDetail?.content,
      );
      return enqueueAutoPatchForAssistant(
        sessionId,
        latestAssistant,
        prompt,
        before,
        target,
      );
    },
    [
      activeIdRef,
      enqueueAutoPatchForAssistant,
      fileWorkspace.activeFileKey,
      fileWorkspace.previewDetail?.content,
      projectId,
      sessionsRef,
    ],
  );

  const tryPendingAutoPatch = useCallback(() => {
    let prompt = pendingAutoPatchPromptRef.current;
    let target = pendingAutoPatchTargetRef.current;
    const hasTargetFile = pinnedFileIds.length > 0 || roundFileIds.length > 0;

    if (!prompt || !target) {
      const sessionId = activeIdRef.current;
      const session = sessionId
        ? sessionsRef.current.find((item) => item.id === sessionId)
        : undefined;
      if (!session || !hasTargetFile) return;
      const latestPrompt = findLatestTurnUserPrompt(session.messages);
      target =
        resolveAutoPatchTargetFile(
          pinnedFileIds,
          roundFileIds,
          fileWorkspace.files,
          fileWorkspace.tabLabels,
        ) ?? target;
      if (
        latestPrompt &&
        target &&
        isRewritePrompt(latestPrompt, { hasTargetFile: true })
      ) {
        prompt = latestPrompt;
        pendingAutoPatchPromptRef.current = prompt;
        pendingAutoPatchTargetRef.current = target;
        console.info("[co-create] 恢复未落库的改写轮次", { prompt: prompt.slice(0, 40) });
      } else {
        return;
      }
    }

    void maybeAutoPatchFromLatestAssistant(prompt, target).then((patched) => {
      if (patched) {
        console.info("[co-create] 自动改写提案就绪", { prompt: prompt.slice(0, 40) });
      }
      const sessionId = activeIdRef.current;
      const session = sessionId
        ? sessionsRef.current.find((item) => item.id === sessionId)
        : undefined;
      const latestAssistant = session
        ? [...session.messages].reverse().find((message) => message.role === "assistant")
        : undefined;
      const proposalId = latestAssistant
        ? autoPatchFallbackProposalId(latestAssistant.id)
        : "";
      const applied = latestAssistant?.fileActions?.find(
        (item) => item.proposalId === proposalId && item.status === "applied",
      );
      if (applied) {
        pendingAutoPatchPromptRef.current = null;
        pendingAutoPatchTargetRef.current = null;
      }
    });
  }, [
    activeIdRef,
    fileWorkspace.files,
    fileWorkspace.tabLabels,
    maybeAutoPatchFromLatestAssistant,
    pinnedFileIds,
    roundFileIds,
    sessionsRef,
  ]);

  const tryPendingAutoCreateDraft = useCallback(() => {
    const prompt = pendingAutoDraftPromptRef.current;
    if (!prompt) return;
    const created = maybeAutoCreateDraftFromLatestAssistant(prompt);
    if (created) {
      console.info("[co-create] 自动建稿提案就绪", { prompt: prompt.slice(0, 40) });
    }
    const sessionId = activeIdRef.current;
    const session = sessionId
      ? sessionsRef.current.find((item) => item.id === sessionId)
      : undefined;
    const latestAssistant = session
      ? [...session.messages].reverse().find((message) => message.role === "assistant")
      : undefined;
    const proposalId = latestAssistant
      ? autoCreateFallbackProposalId(latestAssistant.id)
      : "";
    const applied = latestAssistant?.fileActions?.find(
      (item) => item.proposalId === proposalId && item.status === "applied",
    );
    if (applied) {
      pendingAutoDraftPromptRef.current = null;
      pendingQuickEntryTitleRef.current = null;
    }
  }, [activeIdRef, maybeAutoCreateDraftFromLatestAssistant, sessionsRef]);

  const latestAssistantContent = useMemo(() => {
    const messages = activeSession?.messages ?? [];
    return [...messages].reverse().find((message) => message.role === "assistant")?.content ?? "";
  }, [activeSession?.messages]);

  useEffect(() => {
    if (streaming || preparingContext || !pendingAutoDraftPromptRef.current) return;
    const timer = window.setTimeout(() => {
      tryPendingAutoCreateDraft();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [latestAssistantContent, preparingContext, streaming, tryPendingAutoCreateDraft]);

  useEffect(() => {
    if (streaming || preparingContext || !pendingAutoPatchPromptRef.current) return;
    const timer = window.setTimeout(() => {
      tryPendingAutoPatch();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [latestAssistantContent, preparingContext, streaming, tryPendingAutoPatch]);

  useEffect(() => {
    if (streaming || preparingContext) return;
    tryPendingAutoCreateDraft();
    tryPendingAutoPatch();
  }, [preparingContext, streaming, tryPendingAutoCreateDraft, tryPendingAutoPatch]);

  useEffect(() => {
    if (!activeId || streaming || !latestAssistantContent.trim()) return;
    const session = sessionsRef.current.find((item) => item.id === activeId);
    const latestAssistant = session
      ? [...session.messages].reverse().find((message) => message.role === "assistant")
      : undefined;
    if (!latestAssistant) return;

    setPendingActions((prev) => {
      const reconciled = reconcileStreamCreateProposals(
        prev,
        latestAssistantContent,
        extractAutoCreateDraftBody,
        existingOutputTitles,
      );
      if (JSON.stringify(prev) === JSON.stringify(reconciled)) return prev;
      for (const proposal of reconciled) {
        if (proposal.type === "create" && proposal.status === "proposed") {
          autoApplyingProposalIdsRef.current.delete(proposal.proposalId);
        }
      }
      return reconciled;
    });

    const reconciledMessageActions = reconcileStreamCreateProposals(
      latestAssistant.fileActions ?? [],
      latestAssistantContent,
      extractAutoCreateDraftBody,
      existingOutputTitles,
    );
    if (
      JSON.stringify(latestAssistant.fileActions ?? []) === JSON.stringify(reconciledMessageActions)
    ) {
      return;
    }
    updateSession(activeId, (item) => ({
      ...item,
      messages: item.messages.map((message) =>
        message.id === latestAssistant.id
          ? { ...message, fileActions: reconciledMessageActions }
          : message,
      ),
    }));

    const patchTarget =
      pendingAutoPatchTargetRef.current ??
      resolveAutoPatchTargetFile(
        pinnedFileIds,
        roundFileIds,
        fileWorkspace.files,
        fileWorkspace.tabLabels,
      );
    if (!patchTarget) return;

    void resolveFileBeforeContent(
      projectId,
      patchTarget,
      fileWorkspace.activeFileKey,
      fileWorkspace.previewDetail?.content,
    ).then((beforeContent) => {
      setPendingActions((prev) => {
        const reconciled = reconcileStreamPatchProposals(
          prev,
          latestAssistantContent,
          beforeContent,
          extractAutoPatchBody,
        );
        if (JSON.stringify(prev) === JSON.stringify(reconciled)) return prev;
        for (const proposal of reconciled) {
          if (proposal.type === "patch" && proposal.status === "proposed") {
            autoApplyingProposalIdsRef.current.delete(proposal.proposalId);
          }
        }
        return reconciled;
      });

      const reconciledPatchActions = reconcileStreamPatchProposals(
        latestAssistant.fileActions ?? [],
        latestAssistantContent,
        beforeContent,
        extractAutoPatchBody,
      );
      if (
        JSON.stringify(latestAssistant.fileActions ?? []) !==
        JSON.stringify(reconciledPatchActions)
      ) {
        updateSession(activeId, (item) => ({
          ...item,
          messages: item.messages.map((message) =>
            message.id === latestAssistant.id
              ? { ...message, fileActions: reconciledPatchActions }
              : message,
          ),
        }));
      }
    });
  }, [
    activeId,
    existingOutputTitles,
    fileWorkspace.activeFileKey,
    fileWorkspace.files,
    fileWorkspace.previewDetail?.content,
    fileWorkspace.tabLabels,
    latestAssistantContent,
    pinnedFileIds,
    projectId,
    roundFileIds,
    sessionsRef,
    streaming,
    updateSession,
  ]);

  const tasksExecuteUrl = apiV1("/tasks/execute");
  const chatApiBase = process.env.NEXT_PUBLIC_CHAT_API_URL?.trim() || apiV1("/chat/completions");
  const chatApiKey = process.env.NEXT_PUBLIC_CHAT_API_KEY?.trim() || "";

  const projectFileIdsForExecute = useMemo(
    () => decodeFileIds(roundFileIds),
    [roundFileIds],
  );
  const pinnedIdsForExecute = useMemo(() => decodeFileIds(pinnedFileIds), [pinnedFileIds]);

  const { sendMessage } = useChatExecution({
    input,
    streaming,
    preparingContext,
    setStreaming,
    setPreparingContext,
    setStreamingPhase,
    setError,
    setInput,
    setSessionsSyncError,
    chatMode: "co_create",
    includeFileContext: roundFileIds.length > 0 || pinnedFileIds.length > 0,
    includeKnowledgeContext: false,
    includeProjectContext: true,
    includeSkillsContext: agentMode === "plan",
    selectedCollection: collections[0] ?? "",
    selectedFileId: roundFileIds[0] ?? pinnedFileIds[0] ?? "",
    selectedProjectId: projectId,
    projectFiles: fileWorkspace.files as ProjectFileItem[],
    projectFilesLoading: fileWorkspace.loading,
    projectTaskContext: projectContext,
    orchestrationPreview: null,
    rewriteGoal: "",
    rewriteSourceExcerpt: "",
    rewriteTargetSection: "",
    scenarioFromUrl: "",
    skills,
    showAdvancedOrchestration: false,
    useOrchestration: true,
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
    isPlaceholderSessionTitle: isPlaceholderFromStore,
    condenseTopicTitle: condenseFromStore,
    coCreateSessionId: activeId ?? undefined,
    coCreateAgentMode: agentMode,
    projectFileIds: projectFileIdsForExecute,
    pinnedFileIdsForExecute: pinnedIdsForExecute,
    onFileActionsFromStream: handleFileActionsFromStream,
  });

  const allPatchProposals = useMemo(() => {
    const fromMessages = (activeSession?.messages ?? []).flatMap((m) => m.fileActions ?? []);
    return [...fromMessages, ...pendingActions];
  }, [activeSession?.messages, pendingActions]);

  const handleAgentModeChange = useCallback(
    (value: CoCreateAgentMode) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        coCreateAgentMode: value,
        coCreateApplyMode: value === "ask" ? "review" : session.coCreateApplyMode ?? "auto",
        coCreatePlanPhase: value === "plan" ? session.coCreatePlanPhase ?? "idle" : "idle",
      }));
      const updated = sessionsRef.current.find((session) => session.id === activeSession.id);
      if (updated) queueSessionPatch(activeSession.id, sessionToPatchPayload(updated), 0);
      console.info("[co-create] Agent 模式切换", { mode: value });
    },
    [activeSession, queueSessionPatch, sessionsRef, updateSession],
  );

  const handleApplyModeChange = useCallback(
    (value: CoCreateApplyMode) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        coCreateApplyMode: value,
      }));
      const updated = sessionsRef.current.find((session) => session.id === activeSession.id);
      if (updated) queueSessionPatch(activeSession.id, sessionToPatchPayload(updated));
      console.info("[co-create] 应用模式切换", { mode: value });
    },
    [activeSession, queueSessionPatch, sessionsRef, updateSession],
  );

  const activePendingPatch = useMemo(() => {
    const proposal = findActivePatchProposal(fileWorkspace.activeFileKey, allPatchProposals);
    if (!proposal) return null;
    const before =
      proposal.before?.trim() ||
      fileWorkspace.previewDetail?.content ||
      "";
    const after = resolvePatchAfterFromProposal(proposal, before);
    return {
      ...proposal,
      before,
      after,
    };
  }, [allPatchProposals, fileWorkspace.activeFileKey, fileWorkspace.previewDetail?.content]);

  const handleStartNewSession = useCallback(
    (options?: { title?: string }) => {
      if (streaming) {
        abortRef.current?.abort();
        setStreaming(false);
        setPreparingContext(false);
        setStreamingPhase("");
      }
      resetComposerContext();
      resetTransient();
      fileWorkspace.resetWorkspace();
      const defaults = {
        ...projectCoCreateSessionDefaults(projectId),
        ...(options?.title?.trim() ? { title: options.title.trim() } : {}),
      };
      createSession(defaults);
      console.info("[co-create] /new 新建会话", {
        projectId,
        title: options?.title?.trim() || null,
      });
    },
    [
      createSession,
      fileWorkspace,
      projectId,
      resetComposerContext,
      resetTransient,
      streaming,
    ],
  );

  const handleSend = useCallback(
    async (overridePrompt?: string) => {
      const rawPrompt = (overridePrompt ?? input).trim();
      const newCommand = parseCoCreateNewCommand(rawPrompt);
      if (newCommand && regionBlocks.length === 0) {
        handleStartNewSession(newCommand);
        return;
      }
      let userPrompt = rawPrompt;
      if (!userPrompt && regionBlocks.length === 0) return;
      if (userPrompt.startsWith("/生成新文件")) {
        userPrompt = userPrompt.replace(
          /^\/生成新文件\s*/,
          "请基于当前项目上下文，生成一个新文件并给出完整内容。",
        );
      } else if (userPrompt.startsWith("/改写当前文件")) {
        userPrompt = userPrompt.replace(
          /^\/改写当前文件\s*/,
          "请基于当前引用的文件，按以下要求改写：",
        );
      }
      const excerpts = regionBlocksToExcerpts(regionBlocks);
      const fullText = composeUserMessageForApi(userPrompt, excerpts);
      const hasTargetFile = pinnedFileIds.length > 0 || roundFileIds.length > 0;
      const autoPipeline = resolveCoCreatePipeline({
        text: rawPrompt,
        pinnedFileCount: pinnedFileIds.length,
        roundFileCount: roundFileIds.length,
        regionBlockCount: regionBlocks.length,
        hasPendingFileActions: pendingActions.some(
          (proposal) => proposal.status === "applying" || proposal.status === "applied",
        ),
      });
      const execution = resolveExecutionFromAgentMode(agentMode, autoPipeline);

      const planConfirm = agentMode === "plan" && isPlanConfirmPrompt(rawPrompt);
      const planInstructionPhase = (() => {
        if (agentMode !== "plan") return undefined;
        if (planConfirm || planPhase === "executing") return "executing" as const;
        if (planPhase === "awaiting_confirm") return "revising" as const;
        return "planning" as const;
      })();

      if (planConfirm) {
        persistPlanPhase("executing");
        console.info("[co-create] Plan 用户确认，进入执行阶段");
      }

      if (
        pinnedFileIds.length === 0 &&
        roundFileIds.length === 0 &&
        rawPrompt.trim().length > 4
      ) {
        const excluded = new Set([...pinnedFileIds, ...roundFileIds]);
        const recs = inferFileRecommendations(rawPrompt, fileWorkspace.files, excluded);
        if (recs.length > 0) {
          setRecommendations(recs);
          console.info("[co-create] 推荐引用文件", { count: recs.length });
        }
      }

      const regionInstruction = buildRegionAwarePatchInstructions(excerpts);
      const modeInstruction = buildAgentModeInstructions(agentMode, {
        planPhase: planInstructionPhase,
        availableSkills: skills,
        confirmedPlan: planConfirm || planPhase === "executing" ? latestConfirmedPlan : null,
      });
      const documentSyncInstruction = buildDocumentSyncInstructions(
        rawPrompt,
        existingOutputTitles,
      );
      const rewriteSyncInstruction = buildRewriteSyncInstructions(rawPrompt, hasTargetFile);
      const presetAppend = [
        modeInstruction,
        regionInstruction,
        documentSyncInstruction,
        rewriteSyncInstruction,
      ]
        .filter(Boolean)
        .join("\n\n");

      if (!overridePrompt) {
        setInput("");
      }
      setRegionBlocks([]);
      const planAllowsAutoDraft =
        execution.allowAutoDraft &&
        agentMode === "plan" &&
        (planConfirm || planPhase === "executing");

      await sendMessage(fullText, {
        userPrompt: userPrompt || undefined,
        regionExcerpts: excerpts.length > 0 ? excerpts : undefined,
        useOrchestrationOverride: execution.useOrchestration,
        skipToolsContextBuild: execution.skipTools,
        scenarioPresetInstructionsAppend: presetAppend || undefined,
      });
      if (planAllowsAutoDraft && isDocumentGenerationPrompt(rawPrompt)) {
        pendingAutoDraftPromptRef.current = rawPrompt;
        tryPendingAutoCreateDraft();
      }
      if (planAllowsAutoDraft && isRewritePrompt(rawPrompt, { hasTargetFile })) {
        const patchTarget = resolveAutoPatchTargetFile(
          pinnedFileIds,
          roundFileIds,
          fileWorkspace.files,
          fileWorkspace.tabLabels,
        );
        if (patchTarget) {
          pendingAutoPatchPromptRef.current = rawPrompt;
          pendingAutoPatchTargetRef.current = patchTarget;
          tryPendingAutoPatch();
        }
      } else if (
        execution.allowAutoDraft &&
        agentMode !== "plan" &&
        isDocumentGenerationPrompt(rawPrompt)
      ) {
        pendingAutoDraftPromptRef.current = rawPrompt;
        tryPendingAutoCreateDraft();
      } else if (
        execution.allowAutoDraft &&
        agentMode !== "plan" &&
        isRewritePrompt(rawPrompt, { hasTargetFile })
      ) {
        const patchTarget = resolveAutoPatchTargetFile(
          pinnedFileIds,
          roundFileIds,
          fileWorkspace.files,
          fileWorkspace.tabLabels,
        );
        if (patchTarget) {
          pendingAutoPatchPromptRef.current = rawPrompt;
          pendingAutoPatchTargetRef.current = patchTarget;
          tryPendingAutoPatch();
        }
      }
    },
    [
      agentMode,
      existingOutputTitles,
      fileWorkspace.files,
      fileWorkspace.tabLabels,
      input,
      latestConfirmedPlan,
      pendingActions,
      persistPlanPhase,
      pinnedFileIds,
      planPhase,
      regionBlocks,
      roundFileIds,
      sendMessage,
      skills,
      tryPendingAutoCreateDraft,
      tryPendingAutoPatch,
      handleStartNewSession,
    ],
  );

  const handleConfirmPlanExecution = useCallback(() => {
    void handleSend("开始执行");
  }, [handleSend]);

  const handleQuickStart = useCallback(
    async (entry: CoCreateQuickEntry) => {
      try {
        await ensureDerivedUserId();
      } catch (err) {
        console.warn("[co-create] 用户 ID 派生失败，继续尝试发送", err);
      }

      let scenarioDetail: CoCreateQuickStartScenarioDetail | null = null;
      try {
        scenarioDetail = await apiGet(`/scenarios/${entry.scenarioId}`);
      } catch (err) {
        if (process.env.NODE_ENV === "development") {
          console.warn("[co-create] 场景详情加载失败，使用列表缓存", {
            scenarioId: entry.scenarioId,
            err,
          });
        }
      }

      const plan = buildCoCreateQuickStartPlan({
        entry,
        scenarioDetail,
        agentMode,
        pinnedFileCount: pinnedFileIds.length,
        roundFileCount: roundFileIds.length,
        availableSkills: skills,
        existingOutputTitles,
      });

      console.info("[co-create] 快捷场景启动", {
        scenarioId: entry.scenarioId,
        title: entry.title,
        shouldTryAutoCreateDraft: plan.shouldTryAutoCreateDraft,
        shouldTryAutoPatch: plan.shouldTryAutoPatch,
      });

      await sendMessage(plan.prompt, {
        userPrompt: plan.outputEntryTitle.trim() || entry.title.trim() || undefined,
        useOrchestrationOverride: plan.useOrchestration,
        skipToolsContextBuild: plan.skipTools,
        scenarioIdOverride: plan.scenarioId,
        scenarioPresetInstructionsOverride: plan.scenarioPresetInstructions,
        scenarioPresetInstructionsAppend: plan.scenarioPresetInstructionsAppend,
      });

      if (plan.shouldTryAutoCreateDraft) {
        pendingAutoDraftPromptRef.current = plan.prompt;
        pendingQuickEntryTitleRef.current = plan.outputEntryTitle;
        tryPendingAutoCreateDraft();
      }
      if (plan.shouldTryAutoPatch) {
        const patchTarget = resolveAutoPatchTargetFile(
          pinnedFileIds,
          roundFileIds,
          fileWorkspace.files,
          fileWorkspace.tabLabels,
        );
        if (patchTarget) {
          pendingAutoPatchPromptRef.current = plan.prompt;
          pendingAutoPatchTargetRef.current = patchTarget;
          tryPendingAutoPatch();
        }
      }
    },
    [
      agentMode,
      existingOutputTitles,
      fileWorkspace.files,
      fileWorkspace.tabLabels,
      pinnedFileIds,
      roundFileIds,
      sendMessage,
      tryPendingAutoCreateDraft,
      tryPendingAutoPatch,
    ],
  );

  const applyProposal = useCallback(
    async (
      proposal: FileActionProposal,
      saveMode: "overwrite" | "new_version" | "copy" = "overwrite",
      createOverwriteTarget?: { outputId: string; fileName: string },
    ) => {
      setPendingActions((prev) => updateProposalStatus(proposal.proposalId, "applying", prev));
      syncProposalStatusToSession(proposal.proposalId, "applying");
      setSaveState("saving");
      const sessionForProposal = activeId
        ? sessionsRef.current.find((item) => item.id === activeId)
        : undefined;
      const assistantContent = findAssistantContentForProposal(sessionForProposal, proposal.proposalId);
      const latestProposal =
        sessionForProposal?.messages
          .flatMap((message) => message.fileActions ?? [])
          .find((item) => item.proposalId === proposal.proposalId) ?? proposal;
      if (isCoCreateAttachmentPatchProposal(latestProposal)) {
        throw new Error(CO_CREATE_ATTACHMENT_READONLY_ERROR);
      }
      try {
        let undoEntry: AgentUndoEntry | null = null;
        let previousContent = "";
        if (latestProposal.type === "patch") {
          previousContent = latestProposal.before ?? "";
          if (!previousContent.trim()) {
            const detail = await fetchProjectFileDetail(
              projectId,
              latestProposal.fileId,
              latestProposal.fileKind,
            );
            previousContent = detail.content ?? "";
          }
          undoEntry = {
            type: "patch",
            proposalId: latestProposal.proposalId,
            fileId: latestProposal.fileId,
            fileKind: latestProposal.fileKind,
            fileName: latestProposal.fileName,
            previousContent,
          };
        }

        let resolvedAfter = "";
        const createOverwrite =
          latestProposal.type === "create" && Boolean(createOverwriteTarget?.outputId);
        const action =
          latestProposal.type === "create" && !createOverwrite
            ? (() => {
                const content = resolveCreateActionContent(
                  latestProposal.content,
                  assistantContent,
                  extractAutoCreateDraftBody,
                );
                if (!content.trim()) {
                  throw new Error("创建文件内容不能为空，请重试或手动保存");
                }
                if (!isCreateProposalReadyForApply(latestProposal.content, assistantContent, extractAutoCreateDraftBody)) {
                  throw new Error("文稿正文尚未就绪，请稍候或点击重试");
                }
                return {
                  type: "create" as const,
                  file_name: latestProposal.fileName,
                  path: normalizeCreateFilePath(latestProposal.fileName, latestProposal.path),
                  content,
                };
              })()
            : latestProposal.type === "create" && createOverwrite && createOverwriteTarget
              ? (() => {
                  const content = resolveCreateActionContent(
                    latestProposal.content,
                    assistantContent,
                    extractAutoCreateDraftBody,
                  );
                  if (!content.trim()) {
                    throw new Error("更新内容不能为空，请重试");
                  }
                  if (
                    !isCreateProposalReadyForApply(
                      latestProposal.content,
                      assistantContent,
                      extractAutoCreateDraftBody,
                    )
                  ) {
                    throw new Error("文稿正文尚未就绪，请稍候或点击重试");
                  }
                  resolvedAfter = content;
                  return {
                    type: "patch" as const,
                    target_file_id: createOverwriteTarget.outputId,
                    target_kind: "output" as const,
                    file_name: createOverwriteTarget.fileName,
                    save_mode: "overwrite" as const,
                    edit_mode: "full" as const,
                    content,
                    after: content,
                  };
                })()
            : (() => {
                if (latestProposal.type !== "patch") {
                  throw new Error("无法应用该文件操作");
                }
                resolvedAfter = resolvePatchAfterFromProposal(latestProposal, previousContent);
                const editMode = latestProposal.editMode ?? "full";
                return {
                  type: "patch" as const,
                  target_file_id: latestProposal.fileId,
                  target_kind: latestProposal.fileKind,
                  file_name: latestProposal.fileName,
                  save_mode: saveMode,
                  edit_mode: editMode,
                  content: resolvedAfter,
                  after: resolvedAfter,
                  ...(editMode === "search_replace"
                    ? {
                        old_string: latestProposal.oldString,
                        new_string: latestProposal.newString,
                        replace_all: latestProposal.replaceAll,
                      }
                    : {}),
                  ...(editMode === "line_range"
                    ? {
                        start_line: latestProposal.startLine,
                        end_line: latestProposal.endLine,
                        new_text: latestProposal.newText ?? latestProposal.after,
                      }
                    : {}),
                };
              })();
        if (createOverwrite && createOverwriteTarget) {
          previousContent =
            (
              await fetchProjectFileDetail(
                projectId,
                createOverwriteTarget.outputId,
                "output",
              )
            ).content ?? "";
          undoEntry = {
            type: "patch",
            proposalId: latestProposal.proposalId,
            fileId: createOverwriteTarget.outputId,
            fileKind: "output",
            fileName: createOverwriteTarget.fileName,
            previousContent,
          };
        }
        const result = await applyFileAction(projectId, {
          session_id: activeId ?? undefined,
          proposal_id: latestProposal.proposalId,
          action,
        });
        setPendingActions((prev) =>
          rejectSiblingCreateProposals(
            updateProposalStatus(latestProposal.proposalId, "applied", prev, {
              applyError: undefined,
            }),
            latestProposal.proposalId,
          ),
        );
        syncProposalStatusToSession(latestProposal.proposalId, "applied", true, {
          applyError: undefined,
        });
        if (activeId && latestProposal.type === "create") {
          updateSession(activeId, (session) => ({
            ...session,
            messages: session.messages.map((message) => ({
              ...message,
              fileActions: message.fileActions?.length
                ? rejectSiblingCreateProposals(message.fileActions, latestProposal.proposalId)
                : message.fileActions,
            })),
          }));
        }
        const fileKey =
          createOverwrite && createOverwriteTarget
            ? encodeProjectFileSelectValue("output", createOverwriteTarget.outputId)
            : latestProposal.type === "create"
              ? encodeProjectFileSelectValue(result.kind, result.file_id)
              : encodeProjectFileSelectValue(latestProposal.fileKind, latestProposal.fileId);
        if (latestProposal.type === "patch" || createOverwrite) {
          undoEntry = undoEntry ?? {
            type: "patch",
            proposalId: latestProposal.proposalId,
            fileId: createOverwriteTarget?.outputId ?? (latestProposal.type === "patch" ? latestProposal.fileId : ""),
            fileKind: "output",
            fileName: createOverwriteTarget?.fileName ?? (latestProposal.type === "patch" ? latestProposal.fileName : ""),
            previousContent,
          };
        } else {
          undoEntry = {
            type: "create",
            proposalId: latestProposal.proposalId,
            fileId: result.file_id,
            fileName: latestProposal.fileName,
          };
        }
        setSaveState("saved");
        console.info("[co-create] 文件应用成功", {
          proposalId: latestProposal.proposalId,
          type: latestProposal.type,
          mode: createOverwrite ? "create_overwrite_output" : latestProposal.type,
          fileId: createOverwriteTarget?.outputId ?? result.file_id,
          contentLength:
            latestProposal.type === "create"
              ? action.content?.length ?? 0
              : resolvedAfter.length,
        });
        try {
          fileWorkspace.openFileTab(fileKey);
          if (latestProposal.type === "patch" || createOverwrite) {
            fileWorkspace.patchTabContent(fileKey, resolvedAfter || (latestProposal.type === "patch" ? latestProposal.after : ""));
          }
          await fileWorkspace.refreshFiles();
          await fileWorkspace.reloadFileTab(fileKey);
        } catch (postErr) {
          console.warn("[co-create] 文件应用后刷新失败（文件已落库）", postErr);
        }
        appendAgentUndoEntry(undoEntry);
        appendTouchedFileId(fileKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[co-create] 文件应用失败", {
          proposalId: proposal.proposalId,
          type: proposal.type,
          error: message,
        });
        setPendingActions((prev) =>
          updateProposalStatus(proposal.proposalId, "failed", prev, { applyError: message }),
        );
        syncProposalStatusToSession(proposal.proposalId, "failed", false, { applyError: message });
        setSaveState("error");
        autoApplyingProposalIdsRef.current.delete(proposal.proposalId);
        if (
          proposal.type === "create" &&
          !isAutoCreateFallbackProposal(proposal.proposalId) &&
          sessionForProposal &&
          !hasResolvedCreateForAssistant(
            sessionForProposal.messages.flatMap((message) => message.fileActions ?? []),
          )
        ) {
          const prompt = findLatestTurnUserPrompt(sessionForProposal.messages);
          if (prompt) {
            pendingAutoDraftPromptRef.current = prompt;
            queueMicrotask(() => tryPendingAutoCreateDraft());
          }
        }
        if (
          proposal.type === "patch" &&
          !isAutoPatchFallbackProposal(proposal.proposalId) &&
          sessionForProposal
        ) {
          const prompt = findLatestTurnUserPrompt(sessionForProposal.messages);
          const target =
            pendingAutoPatchTargetRef.current ??
            resolveAutoPatchTargetFile(
              pinnedFileIds,
              roundFileIds,
              fileWorkspace.files,
              fileWorkspace.tabLabels,
            ) ??
            (proposal.type === "patch"
              ? {
                  fileKey: encodeProjectFileSelectValue(proposal.fileKind, proposal.fileId),
                  fileId: proposal.fileId,
                  fileKind: proposal.fileKind,
                  fileName: proposal.fileName,
                }
              : null);
          if (prompt && target) {
            pendingAutoPatchPromptRef.current = prompt;
            pendingAutoPatchTargetRef.current = target;
            queueMicrotask(() => tryPendingAutoPatch());
          }
        }
      }
    },
    [
      activeId,
      appendAgentUndoEntry,
      appendTouchedFileId,
      fileWorkspace,
      pinnedFileIds,
      projectId,
      roundFileIds,
      syncProposalStatusToSession,
      tryPendingAutoCreateDraft,
      tryPendingAutoPatch,
      updateSession,
    ],
  );

  useEffect(() => {
    if (applyMode === "review" || agentMode === "ask") return;
    if (agentMode === "plan" && planPhase !== "executing") return;
    if (autoApplyingBusyRef.current) return;
    const session = activeId ? sessionsRef.current.find((item) => item.id === activeId) : undefined;
    const merged = mergeFileActionProposals(
      ...(session?.messages ?? []).map((message) => message.fileActions ?? []),
      pendingActions,
    );
    const nextProposal = merged.find((item) => {
      if (item.status !== "proposed") return false;
      if (autoApplyingProposalIdsRef.current.has(item.proposalId)) return false;
      if (item.type === "create") {
        // 创建文件需用户确认，避免与 fallback 提案重复展示
        return false;
      }
      if (item.type === "patch") {
        if (item.fileKind === "attachment") return false;
        const assistantContent = findAssistantContentForProposal(session, item.proposalId);
        const before = item.before ?? "";
        return isReadyForAutoPatch(item.after, before, assistantContent);
      }
      return true;
    });
    if (!nextProposal) return;
    autoApplyingBusyRef.current = true;
    autoApplyingProposalIdsRef.current.add(nextProposal.proposalId);
    void applyProposal(nextProposal, nextProposal.type === "patch" ? "overwrite" : "new_version").finally(
      () => {
        autoApplyingProposalIdsRef.current.delete(nextProposal.proposalId);
        autoApplyingBusyRef.current = false;
      },
    );
  }, [activeId, agentMode, applyMode, applyProposal, pendingActions, planPhase, sessionsRef]);

  const handleUndoLastAgentChange = useCallback(async () => {
    const sessionId = activeIdRef.current;
    const session = sessionId
      ? sessionsRef.current.find((item) => item.id === sessionId)
      : undefined;
    const stack = session?.agentUndoStack ?? [];
    const { popped: latest, next } = popAgentUndoStack(stack);
    if (!latest) return;
    setUndoingAgentChange(true);
    setSaveState("saving");
    try {
      if (latest.type === "create") {
        await archiveProjectOutput(projectId, latest.fileId);
        fileWorkspace.closeFileTab(encodeProjectFileSelectValue("output", latest.fileId));
      } else {
        const fileKey = encodeProjectFileSelectValue(latest.fileKind, latest.fileId);
        await applyFileAction(projectId, {
          session_id: sessionId ?? undefined,
          proposal_id: randomUUID(),
          action: {
            type: "patch",
            target_file_id: latest.fileId,
            target_kind: latest.fileKind,
            content: latest.previousContent,
            file_name: latest.fileName,
            save_mode: "overwrite",
          },
        });
        fileWorkspace.openFileTab(fileKey);
        fileWorkspace.patchTabContent(fileKey, latest.previousContent);
        await fileWorkspace.reloadFileTab(fileKey);
      }
      await fileWorkspace.refreshFiles();
      if (sessionId) {
        updateSession(sessionId, (item) => ({ ...item, agentUndoStack: next }));
        const updated = sessionsRef.current.find((item) => item.id === sessionId);
        if (updated) {
          queueSessionPatch(sessionId, sessionToPatchPayload(updated));
        }
      }
      console.info("[co-create] 已撤销 Agent 变更", {
        sessionId,
        proposalId: latest.proposalId,
        remaining: next.length,
      });
      setSaveState("saved");
    } catch (err) {
      console.warn("[co-create] 撤销 AI 修改失败", err);
      setSaveState("error");
    } finally {
      setUndoingAgentChange(false);
    }
  }, [
    activeIdRef,
    fileWorkspace,
    projectId,
    queueSessionPatch,
    sessionsRef,
    updateSession,
  ]);

  const handleSaveFileContent = useCallback(
    async (fileKey: string, content: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) throw new Error("无法识别文件");
      if (decoded.kind !== "output") throw new Error("仅支持编辑输出类文件");

      setFileSaving(true);
      try {
        await applyFileAction(projectId, {
          session_id: activeId ?? undefined,
          proposal_id: randomUUID(),
          action: {
            type: "patch",
            target_file_id: decoded.id,
            target_kind: decoded.kind,
            content,
            file_name: fileWorkspace.tabLabels[fileKey],
            save_mode: "overwrite",
          },
        });
        fileWorkspace.patchTabContent(fileKey, content);
        await fileWorkspace.refreshFiles();
        if (fileWorkspace.activeFileKey === fileKey) {
          await fileWorkspace.reloadFileTab(fileKey);
        }
        setSaveState("saved");
        appendTouchedFileId(fileKey);
        console.info("[co-create] 手动编辑已保存", { projectId, fileKey });
      } catch (err) {
        console.warn("[co-create] 手动编辑保存失败", { projectId, fileKey, err });
        setSaveState("error");
        throw err instanceof Error ? err : new Error("保存失败");
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, appendTouchedFileId, fileWorkspace, projectId],
  );

  const handleRestoreVersion = useCallback(
    async (version: ProjectFileVersionItem) => {
      const fileKey = fileWorkspace.activeFileKey;
      if (!fileKey) throw new Error("请先打开要恢复到的文件");
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded || decoded.kind !== "output") throw new Error("仅支持恢复输出类文件");
      if (version.id === decoded.id) return;

      const label = fileWorkspace.tabLabels[fileKey] ?? version.title ?? "当前文件";
      if (
        !window.confirm(
          `确定将「${label}」恢复为 v${version.version} 的内容吗？\n当前内容会先归档为历史版本。`,
        )
      ) {
        return;
      }

      setFileSaving(true);
      try {
        const detail = await fetchProjectFileDetail(projectId, version.id, "output");
        const content = detail.content ?? "";
        await applyFileAction(projectId, {
          session_id: activeId ?? undefined,
          proposal_id: randomUUID(),
          action: {
            type: "patch",
            target_file_id: decoded.id,
            target_kind: "output",
            content,
            file_name: version.title ?? label,
            save_mode: "overwrite",
          },
        });
        fileWorkspace.patchTabContent(fileKey, content);
        await fileWorkspace.refreshFiles();
        await fileWorkspace.reloadFileTab(fileKey);
        setSaveState("saved");
        appendTouchedFileId(fileKey);
        console.info("[co-create] 版本已恢复", {
          projectId,
          fileKey,
          versionId: version.id,
          version: version.version,
        });
      } catch (err) {
        console.warn("[co-create] 版本恢复失败", {
          projectId,
          fileKey,
          versionId: version.id,
          err,
        });
        setSaveState("error");
        throw err instanceof Error ? err : new Error("恢复失败");
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, appendTouchedFileId, fileWorkspace, projectId],
  );

  const appendRegionBlock = useCallback(
    (payload: SelectionToChatPayload) => {
      const fileKey = fileWorkspace.activeFileKey;
      if (!fileKey) return;
      const block: ContentRegionBlock = {
        id: randomUUID(),
        fileKey,
        fileName: regionBlockFileName(
          fileWorkspace.files,
          fileKey,
          fileWorkspace.tabLabels,
        ),
        ...payload,
      };
      setRegionBlocks((prev) => [...prev, block]);
      console.info("[co-create] 区域块已加入对话框", {
        fileName: block.fileName,
        range: `${block.startLine}-${block.endLine}`,
      });
    },
    [fileWorkspace.activeFileKey, fileWorkspace.files, fileWorkspace.tabLabels],
  );

  const handleAddSelectionToChat = useCallback(
    (payload: SelectionToChatPayload) => {
      if (fileWorkspace.activeFileKey) addToRound(fileWorkspace.activeFileKey);
      appendRegionBlock(payload);
    },
    [addToRound, appendRegionBlock, fileWorkspace.activeFileKey],
  );

  const handleRewriteSelection = useCallback(
    (payload: SelectionToChatPayload) => {
      if (fileWorkspace.activeFileKey) addToRound(fileWorkspace.activeFileKey);
      appendRegionBlock(payload);
      setInput("请改写以下选段：\n\n改写要求：");
    },
    [addToRound, appendRegionBlock, fileWorkspace.activeFileKey],
  );

  const handleRenameSession = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      updateSession(id, (s) => ({ ...s, title: trimmed, titleManuallySet: true }));
      const updated = sessionsRef.current.find((s) => s.id === id);
      if (updated) {
        queueSessionPatch(id, { title: trimmed, titleManuallySet: true });
      }
      console.info("[co-create] 会话已重命名", { sessionId: id, title: trimmed });
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const handleArchiveSession = useCallback(
    (id: string) => {
      updateSession(id, (s) => ({ ...s, archived: true }));
      const updated = sessionsRef.current.find((s) => s.id === id);
      if (updated) queueSessionPatch(id, sessionToPatchPayload(updated));
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const pendingReviewCount = pendingActions.filter((p) => p.status === "proposed").length;
  const agentChangeSummary = (() => {
    const undoSummary = formatAgentUndoSummary(agentUndoStack, { applyMode, agentMode });
    if (applyMode === "review" && pendingReviewCount > 0) {
      return `审阅模式：${pendingReviewCount} 项变更待确认`;
    }
    return undoSummary;
  })();
  const showUndoControl = agentUndoStack.length > 0 && agentMode !== "ask";

  const rejectCreateProposal = useCallback((proposalId: string) => {
    setPendingActions((prev) =>
      prev.map((p) =>
        p.proposalId === proposalId ? { ...p, status: "rejected" as const } : p,
      ),
    );
  }, []);

  const renderCreateFileCard = useCallback(
    (proposal: Extract<FileActionProposal, { type: "create" }>) => (
      <FileCreateCard
        key={proposal.proposalId}
        proposal={proposal}
        onCreateNew={() => void applyProposal(proposal)}
        onUpdateTo={() => setUpdateToCreateProposal(proposal)}
        onCancel={() => rejectCreateProposal(proposal.proposalId)}
        updateToDisabled={outputFiles.length === 0}
      />
    ),
    [applyProposal, outputFiles.length, rejectCreateProposal],
  );

  const messageHasCreateForTarget = useCallback(
    (targetKey: string) =>
      (activeSession?.messages ?? []).some((message) =>
        (message.fileActions ?? []).some(
          (item) =>
            item.type === "create" &&
            item.status !== "rejected" &&
            createProposalTargetKey(item) === targetKey,
        ),
      ),
    [activeSession?.messages],
  );

  const renderMessageExtras = useCallback(
    (message: Message) => {
      const actions = selectVisibleCreateProposals(
        (message.fileActions ?? []).filter((proposal) => proposal.status !== "rejected"),
      );
      const recs = message.fileRecommendations ?? recommendations;
      return (
        <>
          <FileRecommendationCard
            recommendations={recs}
            onAccept={(rec, mode) => {
              const key = encodeProjectFileSelectValue(rec.fileKind, rec.fileId);
              if (mode === "pinned") pinFile(key);
              else addToRound(key);
              setRecommendations((prev) => prev.filter((r) => r.proposalId !== rec.proposalId));
            }}
            onIgnore={(pid) =>
              setRecommendations((prev) => prev.filter((r) => r.proposalId !== pid))
            }
          />
          {actions.map((proposal) =>
            proposal.type === "create" ? (
              renderCreateFileCard(proposal)
            ) : (
              <FilePatchCard
                key={proposal.proposalId}
                proposal={proposal}
                onViewDiff={() => setDiffProposal(proposal)}
                onApply={() => void applyProposal(proposal, "overwrite")}
                onSaveVersion={() => void applyProposal(proposal, "new_version")}
                onSaveCopy={() => void applyProposal(proposal, "copy")}
                onCancel={() =>
                  setPendingActions((prev) =>
                    prev.map((p) =>
                      p.proposalId === proposal.proposalId
                        ? { ...p, status: "rejected" as const }
                        : p,
                    ),
                  )
                }
              />
            ),
          )}
        </>
      );
    },
    [addToRound, applyProposal, pinFile, recommendations, renderCreateFileCard],
  );

  if (!projectId) {
    return <div className="p-8 text-sm text-slate-500">缺少项目 ID</div>;
  }

  if (projectLoadState === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-500">
        加载项目共创…
      </div>
    );
  }

  if (projectLoadState === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">无法打开项目共创</h1>
        <p className="max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          项目不存在、已被删除，或当前 User ID 无权访问。请先在项目中心确认该项目是否可见；若项目由其他账号创建，请在设置中核对
          User ID 是否一致。
        </p>
        <p className="font-mono text-xs text-slate-500">项目 ID：{projectId}</p>
        <div className="flex flex-wrap justify-center gap-3 pt-1">
          <Link
            href="/projects"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
          >
            返回项目中心
          </Link>
          <Link
            href="/settings"
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            查看 User ID 设置
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-white">
      <CoCreateTopbar
        projectName={project?.name ?? projectId}
        projectId={projectId}
        saveState={saveState}
        agentChangeSummary={agentChangeSummary}
        onUndoAgentChange={showUndoControl ? () => void handleUndoLastAgentChange() : undefined}
        undoCount={agentUndoStack.length}
        undoDisabled={undoingAgentChange}
        onToggleSessions={() => setSidebarOpen((v) => !v)}
        sessionsOpen={sidebarOpen}
        onToggleFilesPanel={() => setFilesPanelOpen((v) => !v)}
        filesPanelOpen={filesPanelOpen}
        projectContext={projectContext}
        projectContextLoadState={projectContextLoadState}
        outputCount={fileWorkspace.files.filter((f) => f.kind === "output").length}
        pinnedFileIds={pinnedFileIds}
        roundFileIds={roundFileIds}
        files={fileWorkspace.files}
        onRemoveFileRef={removeFileRef}
      />

      <CoCreateWorkspaceColumns
        sidebarOpen={sidebarOpen}
        filesPanelOpen={filesPanelOpen}
        previewMaximized={previewMaximized}
        session={
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            loading={sessionsLoading}
            syncError={sessionsSyncError}
            projectId={projectId}
            onSelect={selectSession}
            onCreate={handleStartNewSession}
            onDelete={deleteSession}
            onRename={handleRenameSession}
            onArchive={handleArchiveSession}
          />
        }
        message={
          <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-300 dark:border-slate-700">
            {error ? (
              <p className="mx-4 mt-2 shrink-0 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <CoCreateMessageStream
                messages={visibleMessages}
                streaming={streaming}
                streamingPhase={streamingPhase}
                renderAfterMessage={renderMessageExtras}
                quickEntries={coCreateQuickEntries}
                quickEntriesLoading={quickScenariosLoading}
                moreHref={coCreateMoreHref}
                onQuickStart={(entry) => {
                  void handleQuickStart(entry);
                }}
                quickStartDisabled={!activeSession || streaming}
                planAwaitingConfirm={agentMode === "plan" && planPhase === "awaiting_confirm"}
                onConfirmPlan={() => void handleConfirmPlanExecution()}
                planConfirmDisabled={!activeSession || streaming}
              />
              {pendingActions
                .filter(
                  (p) =>
                    p.status !== "rejected" &&
                    !activeSession?.messages.some((m) =>
                      m.fileActions?.some((fa) => fa.proposalId === p.proposalId),
                    ) &&
                    !(
                      p.type === "create" &&
                      (() => {
                        const target = createProposalTargetKey(p);
                        return target ? messageHasCreateForTarget(target) : false;
                      })()
                    ),
                )
                .map((proposal) =>
                  proposal.type === "create" ? (
                    renderCreateFileCard(proposal)
                  ) : (
                    <FilePatchCard
                      key={proposal.proposalId}
                      proposal={proposal}
                      onViewDiff={() => setDiffProposal(proposal)}
                      onApply={() => void applyProposal(proposal, "overwrite")}
                      onSaveVersion={() => void applyProposal(proposal, "new_version")}
                      onSaveCopy={() => void applyProposal(proposal, "copy")}
                      onCancel={() => {}}
                    />
                  ),
                )}
            </div>
            <CoCreateComposer
              input={input}
              onInputChange={setInput}
              onSend={() => void handleSend()}
              disabled={!activeSession}
              streaming={streaming}
              onStop={() => abortRef.current?.abort()}
              hint="从最右栏选文件，在预览栏加入上下文"
              agentMode={agentMode}
              onAgentModeChange={handleAgentModeChange}
              applyMode={applyMode}
              onApplyModeChange={handleApplyModeChange}
              planPhase={planPhase}
              pinnedFileIds={pinnedFileIds}
              roundFileIds={roundFileIds}
              files={fileWorkspace.files}
              onRemoveFileRef={removeFileRef}
              regionBlocks={regionBlocks}
              onRemoveRegionBlock={(id) =>
                setRegionBlocks((prev) => prev.filter((b) => b.id !== id))
              }
              onMentionFile={addToRound}
            />
          </div>
        }
        preview={
          <div className="h-full min-h-0 overflow-hidden border-r border-slate-300 dark:border-slate-700">
            <FilePreviewPanel
              projectId={projectId}
              openTabKeys={fileWorkspace.openTabKeys}
              activeFileKey={fileWorkspace.activeFileKey}
              tabLabels={fileWorkspace.tabLabels}
              previewDetail={fileWorkspace.previewDetail}
              previewLoading={fileWorkspace.previewLoading}
              versions={fileWorkspace.versions}
              saving={fileSaving}
              onSelectTab={fileWorkspace.selectFileTab}
              onCloseTab={fileWorkspace.closeFileTab}
              onAddToRound={addToRound}
              onPin={pinFile}
              onSaveContent={handleSaveFileContent}
              onRestoreVersion={handleRestoreVersion}
              onAddSelectionToChat={handleAddSelectionToChat}
              onRewriteSelection={handleRewriteSelection}
              pendingPatch={
                activePendingPatch
                  ? {
                      before: activePendingPatch.before,
                      after: activePendingPatch.after,
                      summary: activePendingPatch.summary,
                      editMode: activePendingPatch.editMode,
                    }
                  : null
              }
              onAskInterpret={(key) => {
                addToRound(key);
                void sendMessage("请解读当前选中的文件，给出要点摘要。");
              }}
              onAskModify={(key) => {
                addToRound(key);
                if (isCoCreateAttachmentFileKey(key)) {
                  void sendMessage(
                    "请基于当前附件内容，在项目 /输出/ 下创建新的输出物（不要修改原附件）。",
                  );
                  return;
                }
                setInput("/改写当前文件 ");
              }}
              previewMaximized={previewMaximized}
              onTogglePreviewMaximize={() => {
                setPreviewMaximized((v) => {
                  const next = !v;
                  console.info("[co-create] 文件预览窗口", next ? "最大化" : "还原");
                  return next;
                });
              }}
            />
          </div>
        }
        files={
          <ProjectFilesPanel
            projectId={projectId}
            files={fileWorkspace.files}
            loading={fileWorkspace.loading}
            openTabKeys={fileWorkspace.openTabKeys}
            activeFileKey={fileWorkspace.activeFileKey}
            pinnedFileIds={pinnedFileIds}
            roundFileIds={roundFileIds}
            onSelectPreview={handleSelectPreview}
            onRefresh={() => void fileWorkspace.refreshFiles()}
          />
        }
      />

      <UpdateToOutputDialog
        open={Boolean(updateToCreateProposal)}
        fileName={updateToCreateProposal?.fileName ?? ""}
        outputs={outputFiles}
        onClose={() => setUpdateToCreateProposal(null)}
        onSelect={(file) => {
          if (!updateToCreateProposal) return;
          void applyProposal(updateToCreateProposal, "overwrite", {
            outputId: file.id,
            fileName: file.title,
          });
          setUpdateToCreateProposal(null);
          setFilesPanelOpen(true);
          console.info("[co-create] 创建提案已更新到输出物", {
            proposalId: updateToCreateProposal.proposalId,
            outputId: file.id,
            fileName: file.title,
          });
        }}
      />

      <FileDiffModal
        open={Boolean(diffProposal)}
        fileName={diffProposal?.fileName ?? ""}
        before={diffProposal?.before ?? ""}
        after={diffProposal?.after ?? ""}
        onApply={() => {
          if (diffProposal) void applyProposal(diffProposal, "overwrite");
          setDiffProposal(null);
        }}
        onSaveVersion={() => {
          if (diffProposal) void applyProposal(diffProposal, "new_version");
          setDiffProposal(null);
        }}
        onSaveCopy={() => {
          if (diffProposal) void applyProposal(diffProposal, "copy");
          setDiffProposal(null);
        }}
        onClose={() => setDiffProposal(null)}
      />
    </div>
  );
}
