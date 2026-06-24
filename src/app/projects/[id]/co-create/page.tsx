"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

import { apiGet, apiV1 } from "@/lib/api";
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
} from "@/lib/co-create-api";
import {
  projectCoCreateSessionDefaults,
} from "@/lib/chat-session-utils";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import type { Message } from "@/app/chat/chat-types";
import { useChatExecution } from "@/app/chat/hooks/use-chat-execution";
import {
  condenseTopicTitle as condenseFromStore,
  isPlaceholderSessionTitle as isPlaceholderFromStore,
  sessionToPatchPayload,
  useChatSessionStore,
} from "@/app/chat/hooks/use-chat-session-store";
import type {
  ContentRegionBlock,
  CoCreatePipeline,
  CoCreatePipelinePreference,
  FileActionProposal,
  FileRecommendation,
  SelectionToChatPayload,
} from "@/app/projects/[id]/co-create/co-create-types";
import {
  composeUserMessageForApi,
  findActivePatchProposal,
  regionBlocksToExcerpts,
} from "@/app/projects/[id]/co-create/co-create-types";
import { CoCreateWorkspaceColumns } from "@/app/projects/[id]/co-create/components/CoCreateWorkspaceColumns";
import { FilePreviewPanel } from "@/app/projects/[id]/co-create/components/FilePreviewPanel";
import { CoCreateComposer } from "@/app/projects/[id]/co-create/components/CoCreateComposer";
import { CoCreateMessageStream } from "@/app/projects/[id]/co-create/components/CoCreateMessageStream";
import { CoCreateTopbar } from "@/app/projects/[id]/co-create/components/CoCreateTopbar";
import { FileCreateCard } from "@/app/projects/[id]/co-create/components/FileCreateCard";
import { FileDiffModal } from "@/app/projects/[id]/co-create/components/FileDiffModal";
import { FilePatchCard } from "@/app/projects/[id]/co-create/components/FilePatchCard";
import { FileRecommendationCard } from "@/app/projects/[id]/co-create/components/FileRecommendationCard";
import {
  fileKeyFromParams,
  ProjectFilesPanel,
} from "@/app/projects/[id]/co-create/components/ProjectFilesPanel";
import { SessionSidebar } from "@/app/projects/[id]/co-create/components/SessionSidebar";
import { useFileWorkspace } from "@/app/projects/[id]/co-create/hooks/use-file-workspace";

function decodeFileIds(keys: string[]): string[] {
  return keys
    .map((k) => decodeProjectFileSelectValue(k)?.id)
    .filter((id): id is string => Boolean(id));
}

const CO_CREATE_FAST_QUERY_MAX_CHARS = 20;
const CO_CREATE_REWRITE_RE =
  /\/(生成新文件|改写当前文件)|修改|改写|重写|润色|创建|新建|保存|写入|覆盖|patch|diff|apply/i;
const CO_CREATE_FILE_TARGET_RE = /文件|文档|附件|输出物|版本|副本/i;
const CO_CREATE_PROJECT_HEAVY_RE = /当前项目|本项目|这个项目|项目内|项目中|基于项目/i;
const CO_CREATE_RESEARCH_RE =
  /研究|分析|深度|拆解|挖掘|对标|矩阵|趋势|策略|行业|市场|用户|竞品|报告/i;
const CO_CREATE_AUTO_CREATE_VERB_RE = /\/生成新文件|生成|创建|新建|起草|撰写|写/i;
const CO_CREATE_AUTO_CREATE_NOUN_RE =
  /文稿|文档|稿件|报告|方案|文章|PRD|需求文档|汇报|总结|脚本|纪要|提案|计划/i;
const FILE_ACTIONS_BLOCK_RE = /```tphermes_file_actions\s*\n[\s\S]*?```/gi;
const SINGLE_MARKDOWN_BLOCK_RE = /^```(?:markdown|md|mdx)?\s*\n([\s\S]*?)\n```$/i;
const MARKDOWN_TITLE_RE = /^\s*#\s+(.+?)\s*$/m;

export function normalizeAutoCreateDraftContent(content: string): string {
  let next = (content || "").replace(FILE_ACTIONS_BLOCK_RE, "").trim();
  const fenced = next.match(SINGLE_MARKDOWN_BLOCK_RE);
  if (fenced?.[1]) next = fenced[1].trim();
  return next;
}

function isLikelyDraftContent(content: string): boolean {
  if (!content.trim()) return false;
  if (content.length >= 200) return true;
  if (MARKDOWN_TITLE_RE.test(content)) return true;
  const nonEmptyLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 6;
}

function sanitizeDraftFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "自动创建文稿";
}

function inferDraftTitleFromPrompt(prompt: string): string | null {
  const compact = prompt.replace(/\s+/g, "");
  const explicit = compact.match(
    /(?:生成|创建|新建|起草|撰写|写)(?:一篇|一个|一份|篇|份|个)?(?:新)?(.{2,32}?(?:文稿|文档|稿件|报告|方案|文章|PRD|需求文档|汇报|总结|脚本|纪要|提案|计划))/i,
  );
  if (explicit?.[1]) return explicit[1];
  return null;
}

export function inferAutoCreateDraftFileName(prompt: string, content: string): string {
  const normalizedContent = normalizeAutoCreateDraftContent(content);
  const heading = normalizedContent.match(MARKDOWN_TITLE_RE)?.[1]?.trim();
  const title = sanitizeDraftFileName(heading || inferDraftTitleFromPrompt(prompt) || "自动创建文稿");
  return /\.md$/i.test(title) ? title : `${title}.md`;
}

export function shouldAutoCreateDraftFromAssistant(
  prompt: string,
  assistantContent: string,
  hasExistingFileActions = false,
): boolean {
  if (hasExistingFileActions) return false;
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return false;
  if (
    !normalizedPrompt.startsWith("/生成新文件") &&
    !(CO_CREATE_AUTO_CREATE_VERB_RE.test(normalizedPrompt) && CO_CREATE_AUTO_CREATE_NOUN_RE.test(normalizedPrompt))
  ) {
    return false;
  }
  return isLikelyDraftContent(normalizeAutoCreateDraftContent(assistantContent));
}

function shouldUseCoCreateFastPath(options: {
  text: string;
  pinnedFileCount: number;
  roundFileCount: number;
  regionBlockCount: number;
}) {
  const compact = options.text.replace(/\s+/g, "");
  if (!compact) return false;
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

function effectivePipelineFromPreference(
  preference: CoCreatePipelinePreference,
  autoPipeline: CoCreatePipeline,
): CoCreatePipeline {
  return preference === "auto" ? autoPipeline : preference;
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

function mapStreamActions(raw: Array<Record<string, unknown>>): FileActionProposal[] {
  const out: FileActionProposal[] = [];
  for (const item of raw) {
    const proposalId = String(item.proposal_id || item.proposalId || crypto.randomUUID());
    const type = String(item.type || "");
    if (type === "create") {
      out.push({
        type: "create",
        proposalId,
        fileName: String(item.file_name || item.fileName || "新文件.md"),
        path: String(item.path || "/"),
        content: String(item.content || ""),
        status: "proposed",
      });
    } else if (type === "patch") {
      out.push({
        type: "patch",
        proposalId,
        fileId: String(item.file_id || item.fileId || ""),
        fileKind: (item.file_kind || item.fileKind || "output") as "output" | "attachment",
        fileName: String(item.file_name || item.fileName || "文件"),
        summary: String(item.summary || "文件修改"),
        before: String(item.before || ""),
        after: String(item.after || item.content || ""),
        status: "proposed",
      });
    }
  }
  return out;
}

type AgentUndoEntry =
  | {
      type: "create";
      proposalId: string;
      fileId: string;
      fileName: string;
    }
  | {
      type: "patch";
      proposalId: string;
      fileId: string;
      fileKind: "output" | "attachment";
      fileName: string;
      previousContent: string;
    };

function updateProposalStatus(
  proposalId: string,
  status: FileActionProposal["status"],
  actions: FileActionProposal[],
): FileActionProposal[] {
  return actions.map((proposal) =>
    proposal.proposalId === proposalId ? { ...proposal, status } : proposal,
  );
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
  const [projectContext, setProjectContext] = useState<ProjectContextResponse | null>(null);
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [regionBlocks, setRegionBlocks] = useState<ContentRegionBlock[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [preparingContext, setPreparingContext] = useState(false);
  const [streamingPhase, setStreamingPhase] = useState("");
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error" | "pending_apply"
  >("idle");
  const [pendingActions, setPendingActions] = useState<FileActionProposal[]>([]);
  const [recommendations, setRecommendations] = useState<FileRecommendation[]>([]);
  const [diffProposal, setDiffProposal] = useState<Extract<FileActionProposal, { type: "patch" }> | null>(
    null,
  );
  const [fileSaving, setFileSaving] = useState(false);
  const [agentUndoStack, setAgentUndoStack] = useState<AgentUndoEntry[]>([]);
  const [undoingAgentChange, setUndoingAgentChange] = useState(false);
  const [, setActivePipeline] = useState<CoCreatePipeline>("co_create");

  const abortRef = useRef<AbortController | null>(null);
  const firstTokenMetricsRef = useRef({ count: 0, totalMs: 0 });
  const entryAppliedRef = useRef(false);
  const autoApplyingProposalIdsRef = useRef<Set<string>>(new Set());
  const autoApplyingBusyRef = useRef(false);
  const autoCreatedAssistantIdsRef = useRef<Set<string>>(new Set());

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
    setAgentUndoStack([]);
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
  const pipelinePreference = activeSession?.coCreatePipelinePreference ?? "auto";

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
    apiGet<ProjectRecord>(`/projects/${projectId}`)
      .then(setProject)
      .catch(() => setProject(null));
    fetchProjectContext(projectId)
      .then(setProjectContext)
      .catch(() => setProjectContext(null));
    fetchChatBootstrap()
      .then((data) => {
        setCollections(data.collections);
        setSkills(data.skills);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (sessionsLoading || !projectId || entryAppliedRef.current) return;
    const sessionIdFromUrl = searchParams?.get("session_id");
    if (sessionIdFromUrl && sessions.some((s) => s.id === sessionIdFromUrl)) {
      selectSession(sessionIdFromUrl);
      entryAppliedRef.current = true;
      return;
    }
    const outputId = searchParams?.get("output_id");
    const fileId = searchParams?.get("file_id");
    const initialKey = fileKeyFromParams(outputId, fileId, "output");
    const hasProjectSession = sessions.some(
      (s) => s.selectedProjectId === projectId && s.sessionKind === "project_co_create",
    );
    if (!hasProjectSession) {
      const defaults = projectCoCreateSessionDefaults(projectId);
      if (initialKey) {
        defaults.roundFileIds = [initialKey];
        defaults.pinnedFileIds = [];
      }
      createSession(defaults);
    } else if (initialKey) {
      const target = sessions.find((s) => s.selectedProjectId === projectId);
      if (target) {
        selectSession(target.id);
        persistFileRefs(target.pinnedFileIds ?? [], [...new Set([...(target.roundFileIds ?? []), initialKey])]);
        fileWorkspace.openFileTab(initialKey);
      }
    }
    entryAppliedRef.current = true;
  }, [
    createSession,
    fileWorkspace,
    persistFileRefs,
    projectId,
    searchParams,
    selectSession,
    sessions,
    sessionsLoading,
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
    (proposalId: string, status: FileActionProposal["status"], removePending = false) => {
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
                fileActions: updateProposalStatus(proposalId, status, message.fileActions),
              }
            : message,
        ),
      }));
    },
    [activeSession, updateSession],
  );

  const handleFileActionsFromStream = useCallback(
    (sessionId: string, assistantId: string, raw: Array<Record<string, unknown>>) => {
      const mapped = mapStreamActions(raw);
      if (mapped.length === 0) return;
      setPendingActions((prev) => [...prev, ...mapped]);
      updateSession(sessionId, (session) => ({
        ...session,
        pendingProposalIds: [
          ...new Set([...(session.pendingProposalIds ?? []), ...mapped.map((m) => m.proposalId)]),
        ],
        messages: session.messages.map((m) =>
          m.id === assistantId ? { ...m, fileActions: mapped } : m,
        ),
      }));
      const updated = sessionsRef.current.find((s) => s.id === sessionId);
      if (updated) queueSessionPatch(sessionId, sessionToPatchPayload(updated));
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const enqueueAutoCreateDraftForAssistant = useCallback(
    (sessionId: string, assistantMessage: Message | undefined, prompt: string) => {
      if (!assistantMessage || assistantMessage.role !== "assistant") return false;
      if (autoCreatedAssistantIdsRef.current.has(assistantMessage.id)) return false;
      if (
        !shouldAutoCreateDraftFromAssistant(
          prompt,
          assistantMessage.content,
          Boolean(assistantMessage.fileActions?.length),
        )
      ) {
        return false;
      }

      const content = normalizeAutoCreateDraftContent(assistantMessage.content);
      if (!content) return false;

      const fileName = inferAutoCreateDraftFileName(prompt, content);
      const proposal: FileActionProposal = {
        type: "create",
        proposalId: `fallback-create:${assistantMessage.id}`,
        fileName,
        path: `/输出/${fileName}`,
        content,
        status: "proposed",
      };

      autoCreatedAssistantIdsRef.current.add(assistantMessage.id);
      setPendingActions((prev) =>
        prev.some((item) => item.proposalId === proposal.proposalId) ? prev : [...prev, proposal],
      );
      updateSession(sessionId, (session) => ({
        ...session,
        pendingProposalIds: [
          ...new Set([...(session.pendingProposalIds ?? []), proposal.proposalId]),
        ],
        messages: session.messages.map((message) =>
          message.id === assistantMessage.id && !message.fileActions?.length
            ? { ...message, fileActions: [proposal] }
            : message,
        ),
      }));
      const updated = sessionsRef.current.find((s) => s.id === sessionId);
      if (updated) queueSessionPatch(sessionId, sessionToPatchPayload(updated));
      console.info("[co-create] 已为助手正文补充自动建稿提案", {
        sessionId,
        assistantId: assistantMessage.id,
        fileName,
      });
      return true;
    },
    [queueSessionPatch, sessionsRef, updateSession],
  );

  const maybeAutoCreateDraftFromLatestAssistant = useCallback(
    (prompt: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId) return false;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return false;
      const latestAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      return enqueueAutoCreateDraftForAssistant(sessionId, latestAssistant, prompt);
    },
    [activeIdRef, enqueueAutoCreateDraftForAssistant, sessionsRef],
  );

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
    includeSkillsContext: false,
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
    projectFileIds: projectFileIdsForExecute,
    pinnedFileIdsForExecute: pinnedIdsForExecute,
    onFileActionsFromStream: handleFileActionsFromStream,
  });

  const allPatchProposals = useMemo(() => {
    const fromMessages = (activeSession?.messages ?? []).flatMap((m) => m.fileActions ?? []);
    return [...fromMessages, ...pendingActions];
  }, [activeSession?.messages, pendingActions]);

  const draftPipeline = useMemo(
    () => {
      const autoPipeline = resolveCoCreatePipeline({
        text: input,
        pinnedFileCount: pinnedFileIds.length,
        roundFileCount: roundFileIds.length,
        regionBlockCount: regionBlocks.length,
        hasPendingFileActions: pendingActions.some(
          (proposal) => proposal.status === "applying" || proposal.status === "applied",
        ),
      });
      return effectivePipelineFromPreference(pipelinePreference, autoPipeline);
    },
    [input, pendingActions, pinnedFileIds.length, pipelinePreference, regionBlocks.length, roundFileIds.length],
  );

  const handlePipelinePreferenceChange = useCallback(
    (value: CoCreatePipelinePreference) => {
      if (!activeSession) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        coCreatePipelinePreference: value,
      }));
      const updated = sessionsRef.current.find((session) => session.id === activeSession.id);
      if (updated) queueSessionPatch(activeSession.id, sessionToPatchPayload(updated));
      if (!streaming) {
        setActivePipeline(value === "auto" ? draftPipeline : value);
      }
    },
    [activeSession, draftPipeline, queueSessionPatch, sessionsRef, streaming, updateSession],
  );

  const activePendingPatch = useMemo(
    () => findActivePatchProposal(fileWorkspace.activeFileKey, allPatchProposals),
    [allPatchProposals, fileWorkspace.activeFileKey],
  );

  const handleSend = useCallback(async () => {
    const rawPrompt = input.trim();
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
    const autoPipeline = resolveCoCreatePipeline({
      text: rawPrompt,
      pinnedFileCount: pinnedFileIds.length,
      roundFileCount: roundFileIds.length,
      regionBlockCount: regionBlocks.length,
      hasPendingFileActions: pendingActions.some(
        (proposal) => proposal.status === "applying" || proposal.status === "applied",
      ),
    });
    const nextPipeline = effectivePipelineFromPreference(pipelinePreference, autoPipeline);
    const useFastPath = nextPipeline === "fast";
    setActivePipeline(nextPipeline);
    setInput("");
    setRegionBlocks([]);
    await sendMessage(fullText, {
      userPrompt: userPrompt || undefined,
      regionExcerpts: excerpts.length > 0 ? excerpts : undefined,
      useOrchestrationOverride: !useFastPath,
      skipToolsContextBuild: useFastPath,
    });
    maybeAutoCreateDraftFromLatestAssistant(rawPrompt);
  }, [
    input,
    maybeAutoCreateDraftFromLatestAssistant,
    pendingActions,
    pinnedFileIds.length,
    pipelinePreference,
    regionBlocks,
    roundFileIds.length,
    sendMessage,
  ]);

  const applyProposal = useCallback(
    async (
      proposal: FileActionProposal,
      saveMode: "overwrite" | "new_version" | "copy" = "new_version",
    ) => {
      setPendingActions((prev) => updateProposalStatus(proposal.proposalId, "applying", prev));
      syncProposalStatusToSession(proposal.proposalId, "applying");
      setSaveState("saving");
      try {
        let undoEntry: AgentUndoEntry | null = null;
        if (proposal.type === "patch") {
          let previousContent = proposal.before ?? "";
          if (!previousContent.trim()) {
            const detail = await fetchProjectFileDetail(projectId, proposal.fileId, proposal.fileKind);
            previousContent = detail.content ?? "";
          }
          undoEntry = {
            type: "patch",
            proposalId: proposal.proposalId,
            fileId: proposal.fileId,
            fileKind: proposal.fileKind,
            fileName: proposal.fileName,
            previousContent,
          };
        }
        const action =
          proposal.type === "create"
            ? {
                type: "create" as const,
                file_name: proposal.fileName,
                path: proposal.path,
                content: proposal.content,
              }
            : {
                type: "patch" as const,
                target_file_id: proposal.fileId,
                content: proposal.after,
                file_name: proposal.fileName,
                save_mode: saveMode,
              };
        const result = await applyFileAction(projectId, {
          session_id: activeId ?? undefined,
          proposal_id: proposal.proposalId,
          action,
        });
        setPendingActions((prev) => updateProposalStatus(proposal.proposalId, "applied", prev));
        syncProposalStatusToSession(proposal.proposalId, "applied", true);
        const fileKey =
          proposal.type === "create"
            ? encodeProjectFileSelectValue(result.kind, result.file_id)
            : encodeProjectFileSelectValue(proposal.fileKind, proposal.fileId);
        fileWorkspace.openFileTab(fileKey);
        if (proposal.type === "patch") {
          fileWorkspace.patchTabContent(fileKey, proposal.after);
        } else {
          undoEntry = {
            type: "create",
            proposalId: proposal.proposalId,
            fileId: result.file_id,
            fileName: proposal.fileName,
          };
        }
        await fileWorkspace.refreshFiles();
        await fileWorkspace.reloadFileTab(fileKey);
        if (undoEntry) {
          setAgentUndoStack((prev) => [...prev, undoEntry]);
        }
        setSaveState("saved");
      } catch (err) {
        console.warn("[co-create] 文件应用失败", err);
        setPendingActions((prev) => updateProposalStatus(proposal.proposalId, "failed", prev));
        syncProposalStatusToSession(proposal.proposalId, "failed");
        setSaveState("error");
      }
    },
    [activeId, fileWorkspace, projectId, syncProposalStatusToSession],
  );

  useEffect(() => {
    if (autoApplyingBusyRef.current) return;
    const nextProposal = pendingActions.find(
      (proposal) =>
        proposal.status === "proposed" && !autoApplyingProposalIdsRef.current.has(proposal.proposalId),
    );
    if (!nextProposal) return;
    autoApplyingBusyRef.current = true;
    autoApplyingProposalIdsRef.current.add(nextProposal.proposalId);
    void applyProposal(nextProposal, nextProposal.type === "patch" ? "overwrite" : "new_version").finally(
      () => {
        autoApplyingProposalIdsRef.current.delete(nextProposal.proposalId);
        autoApplyingBusyRef.current = false;
      },
    );
  }, [applyProposal, pendingActions]);

  const handleUndoLastAgentChange = useCallback(async () => {
    const latest = agentUndoStack[agentUndoStack.length - 1];
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
          session_id: activeId ?? undefined,
          proposal_id: crypto.randomUUID(),
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
      setAgentUndoStack((prev) => prev.slice(0, -1));
      setSaveState("saved");
    } catch (err) {
      console.warn("[co-create] 撤销 AI 修改失败", err);
      setSaveState("error");
    } finally {
      setUndoingAgentChange(false);
    }
  }, [activeId, agentUndoStack, fileWorkspace, projectId]);

  const handleSaveFileContent = useCallback(
    async (fileKey: string, content: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) throw new Error("无法识别文件");
      if (decoded.kind !== "output") throw new Error("仅支持编辑输出类文件");

      setFileSaving(true);
      try {
        await applyFileAction(projectId, {
          session_id: activeId ?? undefined,
          proposal_id: crypto.randomUUID(),
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
        console.info("[co-create] 手动编辑已保存", { projectId, fileKey });
      } catch (err) {
        console.warn("[co-create] 手动编辑保存失败", { projectId, fileKey, err });
        setSaveState("error");
        throw err instanceof Error ? err : new Error("保存失败");
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, fileWorkspace, projectId],
  );

  const appendRegionBlock = useCallback(
    (payload: SelectionToChatPayload) => {
      const fileKey = fileWorkspace.activeFileKey;
      if (!fileKey) return;
      const block: ContentRegionBlock = {
        id: crypto.randomUUID(),
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

  const handleCreateSession = useCallback(() => {
    createSession(projectCoCreateSessionDefaults(projectId));
  }, [createSession, projectId]);

  const handleRenameSession = useCallback(
    (id: string, title: string) => {
      updateSession(id, (s) => ({ ...s, title }));
      const updated = sessionsRef.current.find((s) => s.id === id);
      if (updated) queueSessionPatch(id, { title });
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

  const latestAgentUndo = agentUndoStack[agentUndoStack.length - 1] ?? null;
  const agentChangeSummary = latestAgentUndo
    ? latestAgentUndo.type === "create"
      ? `Agent 已创建 ${latestAgentUndo.fileName}，默认自动保存`
      : `Agent 已修改 ${latestAgentUndo.fileName}，默认自动保存`
    : "Agent 直改模式已开启，默认自动保存";

  const renderMessageExtras = useCallback(
    (message: Message) => {
      const actions = (message.fileActions ?? []).filter((proposal) => proposal.status !== "rejected");
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
              <FileCreateCard
                key={proposal.proposalId}
                proposal={proposal}
                onCreate={() => void applyProposal(proposal)}
                onEdit={() => {
                  const edited = window.prompt("编辑文件内容", proposal.content);
                  if (edited != null) {
                    setPendingActions((prev) =>
                      prev.map((p) =>
                        p.proposalId === proposal.proposalId && p.type === "create"
                          ? { ...p, content: edited }
                          : p,
                      ),
                    );
                  }
                }}
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
    [addToRound, applyProposal, pinFile, recommendations],
  );

  if (!projectId) {
    return <div className="p-8 text-sm text-slate-500">缺少项目 ID</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-white">
      <CoCreateTopbar
        projectName={project?.name ?? projectId}
        projectId={projectId}
        saveState={saveState}
        agentChangeSummary={agentChangeSummary}
        onUndoAgentChange={latestAgentUndo ? () => void handleUndoLastAgentChange() : undefined}
        undoDisabled={undoingAgentChange}
        onToggleSessions={() => setSidebarOpen((v) => !v)}
        sessionsOpen={sidebarOpen}
        projectContext={projectContext}
        outputCount={fileWorkspace.files.filter((f) => f.kind === "output").length}
        pinnedFileIds={pinnedFileIds}
        roundFileIds={roundFileIds}
        files={fileWorkspace.files}
        onRemoveFileRef={removeFileRef}
      />

      <CoCreateWorkspaceColumns
        sidebarOpen={sidebarOpen}
        session={
          <SessionSidebar
            sessions={sessions}
            activeId={activeId}
            loading={sessionsLoading}
            syncError={sessionsSyncError}
            projectId={projectId}
            onSelect={selectSession}
            onCreate={handleCreateSession}
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
                messages={activeSession?.messages ?? []}
                streaming={streaming}
                streamingPhase={streamingPhase}
                renderAfterMessage={renderMessageExtras}
                onQuickStart={(prompt) => {
                  const autoPipeline = resolveCoCreatePipeline({
                    text: prompt,
                    pinnedFileCount: pinnedFileIds.length,
                    roundFileCount: roundFileIds.length,
                    regionBlockCount: 0,
                  });
                  const pipeline = effectivePipelineFromPreference(
                    pipelinePreference,
                    autoPipeline,
                  );
                  const useFastPath = pipeline === "fast";
                  setActivePipeline(pipeline);
                  void sendMessage(prompt, {
                    useOrchestrationOverride: !useFastPath,
                    skipToolsContextBuild: useFastPath,
                  }).then(() => {
                    maybeAutoCreateDraftFromLatestAssistant(prompt);
                  });
                }}
                quickStartDisabled={!activeSession || streaming}
              />
              {pendingActions
                .filter(
                  (p) =>
                    p.status !== "rejected" &&
                    !activeSession?.messages.some((m) =>
                      m.fileActions?.some((fa) => fa.proposalId === p.proposalId),
                    ),
                )
                .map((proposal) =>
                  proposal.type === "create" ? (
                    <FileCreateCard
                      key={proposal.proposalId}
                      proposal={proposal}
                      onCreate={() => void applyProposal(proposal)}
                      onEdit={() => {}}
                      onCancel={() => {}}
                    />
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
              pipelinePreference={pipelinePreference}
              onPipelinePreferenceChange={handlePipelinePreferenceChange}
              pinnedFileIds={pinnedFileIds}
              roundFileIds={roundFileIds}
              files={fileWorkspace.files}
              onRemoveFileRef={removeFileRef}
              regionBlocks={regionBlocks}
              onRemoveRegionBlock={(id) =>
                setRegionBlocks((prev) => prev.filter((b) => b.id !== id))
              }
            />
          </div>
        }
        preview={
          <div className="h-full min-h-0 overflow-hidden border-r border-slate-300 dark:border-slate-700">
            <FilePreviewPanel
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
              onAddSelectionToChat={handleAddSelectionToChat}
              onRewriteSelection={handleRewriteSelection}
              pendingPatch={
                activePendingPatch
                  ? {
                      before:
                        activePendingPatch.before ??
                        fileWorkspace.previewDetail?.content ??
                        "",
                      after: activePendingPatch.after,
                      summary: activePendingPatch.summary,
                    }
                  : null
              }
              onAskInterpret={(key) => {
                addToRound(key);
                void sendMessage("请解读当前选中的文件，给出要点摘要。");
              }}
              onAskModify={(key) => {
                addToRound(key);
                setInput("/改写当前文件 ");
              }}
            />
          </div>
        }
        files={
          <ProjectFilesPanel
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
