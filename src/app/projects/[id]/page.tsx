"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import Feedback from "@/components/Feedback";
import { apiGet, apiV1, apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import {
  loadProjectQuickScenarios,
  resolveWorkshopScenarioId,
  type ProjectQuickScenarios,
} from "@/lib/project-quick-scenarios";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import {
  entrypointLabel,
  outputStatusLabel,
  projectStatusLabel,
  runStatusLabel,
  scenarioStatusLabel,
} from "@/lib/ui-labels";
import { trackUsage } from "@/lib/usage-tracker";
import { useUserAccess } from "@/lib/admin-access";
import { isSystemAdminRole } from "@/lib/user-admin";
import ProjectMembersPanel from "@/components/projects/ProjectMembersPanel";
import {
  AttachmentPreviewModal,
  type AttachmentPreviewItem,
} from "@/components/projects/AttachmentPreviewModal";
import { ProjectOutputContentBody } from "@/components/project-output-content";
import { formatDateTimeShanghai } from "@/lib/datetime";

interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "archived";
  deadline: string | null;
  background: string | null;
  audience: string | null;
  constraints: unknown;
  my_role?: string | null;
}

const statusColors: Record<string, string> = {
  active: "bg-blue-600",
  paused: "bg-yellow-500",
  completed: "bg-green-600",
  archived: "bg-slate-500",
};

const statusLabels: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

interface ApiOutputRow {
  id: string;
  title: string | null;
  summary: string | null;
  template_id: string | null;
  run_id: string | null;
  scenario_id?: string | null;
  entrypoint?: string | null;
  status: string;
  created_at: string | null;
  content_preview: string;
  kb_ingest_status?: string | null;
  kb_doc_id?: string | null;
  kb_chunk_count?: number | null;
  user_message?: string | null;
}

interface ApiRunRow {
  id: string;
  entrypoint: string;
  status: string;
  created_at: string | null;
  duration_ms: number | null;
  execution_mode?: string | null;
  tool_capture_hit?: boolean | null;
}

interface ApiOutputDetail {
  id: string;
  project_id: string;
  title: string | null;
  summary: string | null;
  content: string;
  template_id: string | null;
  run_id: string | null;
  scenario_id?: string | null;
  entrypoint?: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  content_format: string;
  user_message?: string | null;
}

interface ProjectOutput {
  id: string;
  skill_name: string;
  skill_icon: string;
  title: string;
  content: string;
  created_at: string;
  word_count: number;
  tags: string[];
  scenario_id?: string | null;
  run_id?: string | null;
  entrypoint?: string | null;
  status: string;
  kb_ingest_status?: string | null;
  content_format?: string | null;
  user_message?: string | null;
}

function buildOutputCoCreateLink(projectId: string, outputId: string): string {
  return `/projects/${projectId}/co-create?output_id=${outputId}`;
}

function buildOutputChatRefineLink(
  projectId: string,
  output: Pick<ProjectOutput, "id" | "scenario_id">,
): string {
  const params = new URLSearchParams({
    project_id: projectId,
    output_id: output.id,
  });
  const scenario = output.scenario_id?.trim();
  if (scenario) params.set("scenario", scenario);
  return `/chat?${params.toString()}`;
}

function mapVisibleOutputs(rows: ApiOutputRow[]): ProjectOutput[] {
  return rows.filter((o) => o.status !== "archived").map(mapApiOutput);
}

function mapApiOutput(o: ApiOutputRow): ProjectOutput {
  const body = [o.summary, o.content_preview].filter(Boolean).join("\n\n") || "";
  const tags = [
    outputStatusLabel(o.status),
    o.template_id ? `模版:${o.template_id}` : null,
    o.run_id ? `执行:${o.run_id.slice(0, 8)}` : null,
    o.scenario_id ? `场景:${o.scenario_id.slice(0, 8)}` : null,
  ].filter(Boolean) as string[];
  return {
    id: o.id,
    skill_name: "编排输出",
    skill_icon:
      (o.entrypoint || "").toLowerCase() === "chat"
        ? "💬"
        : (o.entrypoint || "").toLowerCase() === "brainstorm"
          ? "🧠"
          : "📄",
    title: o.title ?? "输出物",
    content: body,
    created_at: o.created_at ?? "",
    word_count: body.replace(/\s/g, "").length,
    tags,
    scenario_id: o.scenario_id ?? null,
    run_id: o.run_id ?? null,
    entrypoint: o.entrypoint ?? null,
    status: o.status || "draft",
    kb_ingest_status: o.kb_ingest_status ?? null,
    user_message: o.user_message ?? null,
  };
}

function outputDisplayTitle(output: ProjectOutput): string {
  if (outputDepositGroup(output) === "chat") {
    const question = (output.user_message || "").trim();
    if (question) {
      return question.length > 100 ? `${question.slice(0, 100)}…` : question;
    }
    return output.title?.trim() || "对话输出";
  }
  return output.title?.trim() || "输出物";
}

type OutputDepositGroup = "chat" | "file";

function outputDepositGroup(output: Pick<ProjectOutput, "entrypoint">): OutputDepositGroup {
  return (output.entrypoint || "").toLowerCase() === "chat" ? "chat" : "file";
}

const OUTPUT_DEPOSIT_GROUPS: {
  key: OutputDepositGroup;
  title: string;
  description: string;
  icon: string;
}[] = [
  {
    key: "chat",
    title: "对话类",
    description: "来自对话创作的沉淀结果",
    icon: "💬",
  },
  {
    key: "file",
    title: "文件类",
    description: "来自场景输出与工坊的正式交付物",
    icon: "📄",
  },
];

function ProjectOutputCard({
  output,
  selected,
  onSelect,
}: {
  output: ProjectOutput;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border bg-slate-200/60 p-4 transition hover:border-slate-300 dark:bg-slate-800/60 dark:hover:border-slate-600 ${
        selected ? "border-blue-500" : "border-slate-300 dark:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="shrink-0 text-2xl">{output.skill_icon}</span>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium sm:text-base" title={outputDisplayTitle(output)}>
                {outputDisplayTitle(output)}
              </h3>
              <span className="shrink-0 text-xs text-slate-500">{formatDateTimeShanghai(output.created_at)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className={outputStatusBadgeClass(output.status)}>
                {output.status === "approved" ? "✓ " : ""}
                {outputStatusLabel(output.status)}
              </span>
              <span className={kbIngestBadgeClass(output.kb_ingest_status)}>
                KB {kbIngestStatusLabel(output.kb_ingest_status)}
              </span>
              {output.tags
                .filter((tag) => tag !== outputStatusLabel(output.status))
                .map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-slate-300/60 px-2 py-0.5 text-xs text-slate-400 dark:bg-slate-700/60"
                  >
                    {tag}
                  </span>
                ))}
              <span className="text-xs text-slate-500">{output.word_count.toLocaleString()} 字</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectOutputDetailPanel({
  output,
  outputFullContent,
  outputDetailLoading,
  copied,
  outputActionLinks,
  outputGovernBusy,
  onCopy,
  onClose,
  onArchive,
}: {
  output: ProjectOutput;
  outputFullContent: string | null;
  outputDetailLoading: boolean;
  copied: boolean;
  outputActionLinks: { chat: string; coCreate: string } | null;
  outputGovernBusy: boolean;
  onCopy: () => void;
  onClose: () => void;
  onArchive: () => void;
}) {
  const displayContent = outputFullContent ?? output.content;
  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-2xl border border-slate-300 bg-slate-200/80 dark:border-slate-700 dark:bg-slate-800/80 lg:max-h-[calc(100vh-8rem)]">
      <div className="flex items-start justify-between gap-3 border-b border-slate-300 p-4 dark:border-slate-700">
        <div className="flex min-w-0 items-start gap-3">
          <span className="text-2xl shrink-0">{output.skill_icon}</span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold sm:text-base" title={outputDisplayTitle(output)}>
              {outputDisplayTitle(output)}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <p className="text-xs text-slate-500">
                {output.skill_name} · {formatDateTimeShanghai(output.created_at)}
              </p>
              <span className={outputStatusBadgeClass(output.status)}>
                {output.status === "approved" ? "✓ " : ""}
                {outputStatusLabel(output.status)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              copied
                ? "border-green-500/50 bg-green-500/10 text-green-400"
                : "border-slate-300 bg-slate-300/60 text-slate-700 hover:bg-slate-700 dark:border-slate-600 dark:bg-slate-700/60 dark:text-slate-300"
            }`}
          >
            {copied ? "✓ 已复制" : "复制全文"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-300 px-3 py-1.5 text-sm transition hover:bg-slate-600 dark:bg-slate-700"
            aria-label="关闭详情"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <ProjectOutputContentBody
          content={displayContent}
          contentFormat={output.content_format}
          loading={outputDetailLoading}
        />
      </div>
      <div className="border-t border-slate-300 p-4 dark:border-slate-700">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {outputActionLinks ? (
            <>
              <Link
                href={outputActionLinks.coCreate}
                className="min-w-[8rem] flex-1 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2 text-center text-sm font-medium text-indigo-900 transition hover:bg-indigo-100 dark:border-indigo-500/50 dark:bg-indigo-500/10 dark:text-indigo-200 dark:hover:bg-indigo-500/20"
              >
                项目共创
              </Link>
              <Link
                href={outputActionLinks.chat}
                className="min-w-[8rem] flex-1 rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-center text-sm font-medium text-blue-900 transition hover:bg-blue-100 dark:border-blue-500/50 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
              >
                对话优化
              </Link>
            </>
          ) : null}
          <button
            type="button"
            onClick={onArchive}
            disabled={outputGovernBusy || output.status === "archived"}
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-600/50 dark:bg-amber-500/15 dark:text-amber-100 dark:hover:bg-amber-500/25"
          >
            归档
          </button>
        </div>
      </div>
    </div>
  );
}

function kbIngestStatusLabel(status: string | null | undefined): string {
  const s = (status || "pending").toLowerCase();
  if (s === "ingested") return "已入库";
  if (s === "extracting" || s === "pending") return "入库中";
  if (s === "failed") return "入库失败";
  if (s === "removed") return "已移出";
  return status || "待处理";
}

function kbIngestBadgeClass(status: string | null | undefined): string {
  const s = (status || "pending").toLowerCase();
  if (s === "ingested") {
    return "rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 dark:border-emerald-600/40 dark:bg-emerald-500/10 dark:text-emerald-300";
  }
  if (s === "failed") {
    return "rounded border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-800 dark:border-red-700/50 dark:bg-red-950/30 dark:text-red-300";
  }
  if (s === "extracting" || s === "pending") {
    return "rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-600/40 dark:bg-amber-500/10 dark:text-amber-200";
  }
  return "rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700/60 dark:text-slate-400";
}

interface ApiAttachmentRow {
  id: string;
  project_id: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string | null;
  ingest_status?: string | null;
  kb_doc_id?: string | null;
  chunk_count?: number | null;
  ingest_error?: string | null;
  ingested_at?: string | null;
}

/** GET /projects/{id}/scenarios */
interface ProjectBoundScenario {
  binding_id: string;
  scenario_id: string;
  scenario_code: string;
  scenario_name: string;
  scenario_version: string;
  scenario_description: string | null;
  scenario_status: string;
  is_default: number;
  enabled: number;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function constraintsToEditString(constraints: unknown): string {
  if (constraints == null) return "";
  if (typeof constraints === "string") return constraints;
  try {
    return JSON.stringify(constraints, null, 2);
  } catch {
    return String(constraints);
  }
}

function outputStatusBadgeClass(status: string): string {
  const k = status.toLowerCase();
  if (k === "approved") {
    return "rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-600/50 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (k === "archived") {
    return "rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-600/40 dark:bg-amber-500/10 dark:text-amber-200/90";
  }
  if (k === "completed") {
    return "rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800 dark:border-blue-600/40 dark:bg-blue-500/10 dark:text-blue-200/90";
  }
  return "rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700/60 dark:text-slate-400";
}

function sanitizeAttachmentBaseName(name: string): string {
  const trimmed = name.trim() || "项目说明";
  return trimmed.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

function attachmentDateStamp(value: string | Date | null | undefined): string {
  const parsed = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "00000000";
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("");
}

function attachmentUserIdPrefix(userId: string): string {
  return (userId || "default").trim().slice(0, 8) || "default";
}

function buildPasteTextAttachmentFilename(projectName: string, userId: string): string {
  const date = attachmentDateStamp(new Date());
  const uid = attachmentUserIdPrefix(userId);
  return `${sanitizeAttachmentBaseName(projectName)}_${date}_${uid}.md`;
}

export default function ProjectDetailPage() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [outputs, setOutputs] = useState<ProjectOutput[]>([]);
  const [outputsLoadError, setOutputsLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ApiRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialTab = searchParams?.get("tab");
  const [activeTab, setActiveTab] = useState<"info" | "outputs" | "runs" | "members" | "feedback">(
    initialTab === "outputs" ||
      initialTab === "runs" ||
      initialTab === "members" ||
      initialTab === "feedback"
      ? initialTab
      : "info",
  );
  const [selectedOutput, setSelectedOutput] = useState<ProjectOutput | null>(null);
  const [copied, setCopied] = useState(false);
  const [outputFullContent, setOutputFullContent] = useState<string | null>(null);
  const [outputDetailLoading, setOutputDetailLoading] = useState(false);
  const [attachments, setAttachments] = useState<ApiAttachmentRow[]>([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [attachmentOcrUploading, setAttachmentOcrUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentPreviewItem | null>(null);
  const [pasteTextOpen, setPasteTextOpen] = useState(false);
  const [pasteTextContent, setPasteTextContent] = useState("");
  const [pasteTextSaving, setPasteTextSaving] = useState(false);
  const [outputGovernBusy, setOutputGovernBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageOcrInputRef = useRef<HTMLInputElement>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    background: "",
    audience: "",
    deadline: "",
    constraints: "",
    status: "active" as Project["status"],
  });

  const scopeUserId = useEffectiveUserScopeId();
  const { access } = useUserAccess();
  const canViewRuns = useMemo(
    () => isSystemAdminRole(access?.platform_role),
    [access?.platform_role],
  );
  const [boundScenarios, setBoundScenarios] = useState<ProjectBoundScenario[]>([]);
  const [boundLoading, setBoundLoading] = useState(false);
  const [quickDraft, setQuickDraft] = useState<ProjectQuickScenarios>({
    scenarioIds: [],
    defaultScenarioId: null,
  });
  const quickDraftInitializedRef = useRef(false);

  const refreshAttachments = useCallback(async () => {
    if (!id) return;
    const list = await apiGet<ApiAttachmentRow[]>(
      `/projects/${String(id)}/attachments`,
    ).catch(() => [] as ApiAttachmentRow[]);
    setAttachments(list);
  }, [id]);

  const refreshBoundScenarios = useCallback(async () => {
    if (!id) return;
    setBoundLoading(true);
    try {
      const rows = await apiGet<ProjectBoundScenario[]>(`/projects/${String(id)}/scenarios`);
      setBoundScenarios(rows);
    } catch {
      setBoundScenarios([]);
    } finally {
      setBoundLoading(false);
    }
  }, [id]);

  const refreshOutputs = useCallback(async (): Promise<ProjectOutput[]> => {
    if (!id) return [];
    try {
      const outRows = await apiGet<ApiOutputRow[]>(`/projects/${String(id)}/outputs`);
      setOutputsLoadError(null);
      const mapped = mapVisibleOutputs(outRows);
      setOutputs(mapped);
      return mapped;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[projects] outputs refresh failed", { projectId: id, error: message });
      setOutputsLoadError(message);
      setOutputs([]);
      return [];
    }
  }, [id]);

  useEffect(() => {
    quickDraftInitializedRef.current = false;
  }, [id, scopeUserId]);

  useEffect(() => {
    if (!id || quickDraftInitializedRef.current || boundLoading) return;
    const saved = loadProjectQuickScenarios(scopeUserId, String(id));
    if (saved) {
      setQuickDraft(saved);
      quickDraftInitializedRef.current = true;
      return;
    }
    const enabled = boundScenarios.filter((b) => b.enabled === 1);
    if (enabled.length > 0) {
      setQuickDraft({
        scenarioIds: enabled.map((b) => b.scenario_id),
        defaultScenarioId:
          enabled.find((b) => b.is_default === 1)?.scenario_id ??
          enabled[0]?.scenario_id ??
          null,
      });
    }
    quickDraftInitializedRef.current = true;
  }, [id, scopeUserId, boundScenarios, boundLoading]);

  useEffect(() => {
    if (!id) return;
    void refreshBoundScenarios();
  }, [id, refreshBoundScenarios]);

  useEffect(() => {
    if (!canViewRuns && activeTab === "runs") {
      setActiveTab("info");
    }
  }, [canViewRuns, activeTab]);

  useEffect(() => {
    if (!id) return;
    trackUsage({
      eventName: "project_detail_view",
      feature: "projects",
      action: "detail_view",
      projectId: String(id),
    });
    let cancelled = false;
    let outputsFetchFailed = false;
    setLoading(true);
    setError(null);
    setOutputsLoadError(null);
    Promise.all([
      apiGet<Project>(`/projects/${String(id)}`),
      apiGet<ApiOutputRow[]>(`/projects/${String(id)}/outputs`).catch((e: unknown) => {
        outputsFetchFailed = true;
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[projects] outputs load failed", { projectId: id, error: message });
        if (!cancelled) setOutputsLoadError(message);
        return [] as ApiOutputRow[];
      }),
      apiGet<ApiAttachmentRow[]>(`/projects/${String(id)}/attachments`).catch(
        () => [] as ApiAttachmentRow[],
      ),
    ])
      .then(([proj, outRows, attachRows]) => {
        if (!cancelled) {
          setProject(proj);
          setOutputs(mapVisibleOutputs(outRows));
          setAttachments(attachRows);
          if (!outputsFetchFailed) setOutputsLoadError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || !canViewRuns) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    apiGet<ApiRunRow[]>(`/projects/${String(id)}/runs`)
      .then((runRows) => {
        if (!cancelled) setRuns(runRows);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id, canViewRuns]);

  useEffect(() => {
    if (!id || !selectedOutput) {
      setOutputFullContent(null);
      return;
    }
    let cancelled = false;
    setOutputDetailLoading(true);
    setOutputFullContent(null);
    apiGet<ApiOutputDetail>(`/projects/${String(id)}/outputs/${selectedOutput.id}`)
      .then((d) => {
        if (cancelled) return;
        setOutputFullContent(d.content);
        setSelectedOutput((prev) =>
          prev && prev.id === d.id
            ? {
                ...prev,
                status: d.status,
                run_id: d.run_id ?? prev.run_id,
                scenario_id: d.scenario_id ?? prev.scenario_id,
                entrypoint: d.entrypoint ?? prev.entrypoint,
                content_format: d.content_format ?? prev.content_format,
                user_message: d.user_message ?? prev.user_message,
              }
            : prev,
        );
      })
      .catch(() => {
        if (!cancelled) setOutputFullContent(null);
      })
      .finally(() => {
        if (!cancelled) setOutputDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selectedOutput?.id]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleArchiveProjectOutput = async () => {
    if (!id || !selectedOutput) return;
    trackUsage({
      eventName: "project_output_archive_click",
      feature: "projects_outputs",
      action: "archive_click",
      projectId: String(id),
      properties: { output_id: selectedOutput.id },
    });
    setOutputGovernBusy(true);
    try {
      const res = await apiFetch(`/projects/${String(id)}/outputs/${selectedOutput.id}/archive`, {
        method: "POST",
      });
      await readJson(res);
      await refreshOutputs();
      setSelectedOutput(null);
      console.info("[project] 输出已归档", { project_id: id, output_id: selectedOutput.id });
    } catch (e) {
      alert(e instanceof Error ? e.message : "归档失败");
    } finally {
      setOutputGovernBusy(false);
    }
  };

  const uploadAttachmentFile = async (file: File, options?: { ocr?: boolean }) => {
    if (!id) return;
    const fd = new FormData();
    fd.append("file", file);
    const query = options?.ocr ? "?ocr=true" : "";
    const res = await apiFetch(`/projects/${String(id)}/attachments${query}`, {
      method: "POST",
      body: fd,
    });
    await readJson<ApiAttachmentRow>(res);
    await refreshAttachments();
  };

  const handlePickAttachment = () => {
    trackUsage({
      eventName: "project_attachment_pick_click",
      feature: "projects_attachments",
      action: "pick_click",
      projectId: id ? String(id) : undefined,
    });
    setAttachmentError(null);
    fileInputRef.current?.click();
  };

  const handleAttachmentFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !id) return;
    trackUsage({
      eventName: "project_attachment_upload",
      feature: "projects_attachments",
      action: "upload",
      projectId: String(id),
      properties: { file_name: file.name, size: file.size },
    });
    setAttachmentUploading(true);
    setAttachmentError(null);
    try {
      await uploadAttachmentFile(file);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setAttachmentUploading(false);
    }
  };

  const handlePickImageOcr = () => {
    trackUsage({
      eventName: "project_attachment_ocr_pick_click",
      feature: "projects_attachments",
      action: "ocr_pick_click",
      projectId: id ? String(id) : undefined,
    });
    setAttachmentError(null);
    imageOcrInputRef.current?.click();
  };

  const handleImageOcrFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !id) return;
    trackUsage({
      eventName: "project_attachment_ocr_upload",
      feature: "projects_attachments",
      action: "ocr_upload",
      projectId: String(id),
      properties: { file_name: file.name, size: file.size },
    });
    setAttachmentOcrUploading(true);
    setAttachmentError(null);
    try {
      await uploadAttachmentFile(file, { ocr: true });
      console.info("[project] 图片 OCR 已保存为 Markdown 附件", {
        project_id: id,
        file_name: file.name,
      });
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "图片 OCR 失败");
    } finally {
      setAttachmentOcrUploading(false);
    }
  };

  const openPasteTextModal = () => {
    trackUsage({
      eventName: "project_attachment_paste_open",
      feature: "projects_attachments",
      action: "paste_open",
      projectId: id ? String(id) : undefined,
    });
    setAttachmentError(null);
    setPasteTextContent("");
    setPasteTextOpen(true);
  };

  const handleSavePasteText = async () => {
    if (!id || !project) return;
    const text = pasteTextContent.trim();
    if (!text) {
      setAttachmentError("请输入说明文字");
      return;
    }
    const filename = buildPasteTextAttachmentFilename(project.name, scopeUserId);
    trackUsage({
      eventName: "project_attachment_paste_save",
      feature: "projects_attachments",
      action: "paste_save",
      projectId: String(id),
      properties: { file_name: filename, size: text.length },
    });
    setPasteTextSaving(true);
    setAttachmentUploading(true);
    setAttachmentError(null);
    try {
      const file = new File([text], filename, { type: "text/markdown" });
      await uploadAttachmentFile(file);
      console.info("[project] 粘贴说明已保存为附件", {
        project_id: id,
        filename,
        size: text.length,
      });
      setPasteTextOpen(false);
      setPasteTextContent("");
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setPasteTextSaving(false);
      setAttachmentUploading(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    if (!id || !window.confirm("确定删除该附件？")) return;
    setAttachmentError(null);
    try {
      const res = await apiFetch(`/projects/${String(id)}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      await readJson<{ ok: boolean }>(res);
      await refreshAttachments();
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleReingestAttachment = async (attachmentId: string) => {
    if (!id) return;
    setAttachmentError(null);
    try {
      const res = await apiFetch(
        `/projects/${String(id)}/attachments/${attachmentId}/reingest`,
        { method: "POST" },
      );
      await readJson<{ ok: boolean }>(res);
      await refreshAttachments();
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "重新入库失败");
    }
  };

  const openEditProject = () => {
    if (!project) return;
    setEditError(null);
    setEditForm({
      name: project.name,
      background: project.background ?? "",
      audience: project.audience ?? "",
      deadline: project.deadline ?? "",
      constraints: constraintsToEditString(project.constraints),
      status: project.status,
    });
    setEditOpen(true);
  };

  const submitEditProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !editForm.name.trim()) {
      setEditError("项目名称为必填");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    let constraintsPayload: Record<string, unknown> | null = null;
    const raw = editForm.constraints.trim();
    if (raw) {
      try {
        constraintsPayload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        constraintsPayload = { notes: raw };
      }
    }
    try {
      const res = await apiFetch(`/projects/${String(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          background: editForm.background.trim() || null,
          audience: editForm.audience.trim() || null,
          deadline: editForm.deadline.trim() || null,
          constraints: constraintsPayload,
          status: editForm.status,
        }),
      });
      const updated = await readJson<Project>(res);
      setProject(updated);
      setEditOpen(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setEditSaving(false);
    }
  };

  const editInputCls =
    "w-full rounded-lg border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-600 dark:bg-slate-900/80 dark:text-white dark:placeholder-slate-500";

  const totalWords = outputs.reduce((sum, o) => sum + o.word_count, 0);
  const outputsByDepositGroup = useMemo(() => {
    const grouped: Record<OutputDepositGroup, ProjectOutput[]> = { chat: [], file: [] };
    for (const output of outputs) {
      grouped[outputDepositGroup(output)].push(output);
    }
    return grouped;
  }, [outputs]);
  const recentOutputs = useMemo(() => outputs.slice(0, 5), [outputs]);
  const latestRun = runs[0];

  const openOutputFromQuickAccess = useCallback(
    (output: ProjectOutput) => {
      trackUsage({
        eventName: "project_output_quick_access",
        feature: "projects_outputs",
        action: "open_from_console",
        projectId: id ? String(id) : undefined,
        properties: { output_id: output.id, deposit_group: outputDepositGroup(output) },
      });
      setActiveTab("outputs");
      setSelectedOutput(output);
    },
    [id],
  );
  const outputActionLinks = useMemo(() => {
    if (!id || !selectedOutput) return null;
    const projectId = String(id);
    return {
      chat: buildOutputChatRefineLink(projectId, selectedOutput),
      coCreate: buildOutputCoCreateLink(projectId, selectedOutput.id),
    };
  }, [id, selectedOutput]);

  const workshopEntryHref = useMemo(() => {
    if (!id) return "/workshop";
    const params = new URLSearchParams({ project_id: String(id) });
    const scenarioId = resolveWorkshopScenarioId(quickDraft);
    if (scenarioId) params.set("scenario_id", scenarioId);
    return `/workshop?${params.toString()}`;
  }, [id, quickDraft]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <Link
          href="/projects"
          className="mb-6 inline-flex items-center text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white"
        >
          ← 返回项目列表
        </Link>

        {loading && (
          <div className="space-y-4 animate-pulse">
            <div className="h-8 bg-slate-300 dark:bg-slate-700 rounded w-1/2" />
            <div className="h-4 bg-slate-300 dark:bg-slate-700 rounded w-full" />
            <div className="h-32 bg-slate-300 dark:bg-slate-700 rounded" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-red-800 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300">
            加载失败: {error}
          </div>
        )}

        {project && (
          <>
            <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">项目控制台</p>
                <h1 className="mt-2 text-2xl font-bold leading-tight sm:text-3xl md:text-4xl">
                  {project.name}
                </h1>
                <p className="mt-2 text-sm text-slate-400">项目 ID: #{project.id}</p>
              </div>
              <span
                className={`self-start rounded-full px-3 py-1 text-xs font-medium text-slate-900 dark:text-white sm:text-sm ${statusColors[project.status] ?? "bg-slate-500"}`}
              >
                {projectStatusLabel(project.status)}
              </span>
            </div>

            <div className="mb-6 grid gap-3 md:grid-cols-4">
              <MetricCard label="输出物" value={String(outputs.length)} hint="已沉淀结果" />
              <MetricCard label="项目附件" value={String(attachments.length)} hint="上传的参考文件" />
              <MetricCard label="累计字数" value={totalWords.toLocaleString()} hint="输出沉淀体量" />
              <MetricCard
                label="最新活动"
                value={latestRun ? formatDateTimeShanghai(latestRun.created_at) : "暂无"}
                hint={latestRun ? runStatusLabel(latestRun.status) : "等待执行"}
              />
            </div>

            <div className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-300 dark:border-slate-700">
              {[
                { key: "info", label: "控制台" },
                { key: "members", label: "项目成员" },
                { key: "outputs", label: "输出沉淀", badge: outputs.length },
                ...(canViewRuns
                  ? [{ key: "runs" as const, label: "执行记录", badge: runs.length }]
                  : []),
                { key: "feedback", label: "用户反馈" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => {
                    trackUsage({
                      eventName: "project_tab_switch",
                      feature: "projects",
                      action: "switch_tab",
                      projectId: id ? String(id) : undefined,
                      properties: { tab: tab.key },
                    });
                    setActiveTab(tab.key as typeof activeTab);
                  }}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                    activeTab === tab.key
                      ? "border-blue-500 text-slate-900 dark:text-white"
                      : "border-transparent text-slate-400 hover:text-slate-900 dark:hover:text-white hover:border-slate-300 dark:border-slate-600"
                  }`}
                >
                  {tab.label}
                  {tab.badge !== undefined && (
                    <span className="rounded-full bg-blue-600/30 px-1.5 py-0.5 text-xs text-blue-400">
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {activeTab === "info" && (
              <div className="space-y-6">
                <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="space-y-4 rounded-3xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-5 sm:p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                          项目边界
                        </p>
                        <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">项目边界</h2>
                      </div>
                      <button
                        type="button"
                        onClick={openEditProject}
                        className="shrink-0 rounded-full border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900/80 px-3 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 transition hover:border-blue-500/50 hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                      >
                        编辑
                      </button>
                    </div>

                    <InfoField label="项目背景">
                      <p className="leading-relaxed text-slate-800 dark:text-slate-200">
                        {project.background || "暂无描述"}
                      </p>
                    </InfoField>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <InfoField label="目标受众">
                        <p className="text-slate-800 dark:text-slate-200">{project.audience || "未设置"}</p>
                      </InfoField>
                      <InfoField label="截止日期">
                        <p className="text-slate-800 dark:text-slate-200">{project.deadline || "未设置"}</p>
                      </InfoField>
                    </div>

                    <InfoField label="约束条件">
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-2xl bg-slate-100 dark:bg-slate-900/70 p-4 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                        {project.constraints == null
                          ? "暂无约束条件"
                          : typeof project.constraints === "string"
                            ? project.constraints
                            : JSON.stringify(project.constraints, null, 2)}
                      </pre>
                    </InfoField>
                  </div>

                  <div className="rounded-3xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-5 sm:p-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                      快捷操作
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">工作流入口</h2>
                    <div className="mt-5 space-y-3">
                      <ActionLink
                        href={`/projects/${id}/co-create`}
                        title="进入项目共创"
                        desc="围绕项目文件与 Agent 协作创作、修改与沉淀"
                      />
                      <ActionLink
                        href={`/projects/${id}/brainstorm`}
                        title="进入头脑风暴"
                        desc="多角色圆桌辩论，收敛为 Master Plan"
                      />
                      <ActionLink
                        href={`/chat?project_id=${id}&new_chat=1`}
                        title="进入对话创作"
                        desc=""
                      />
                      <Link
                        href={workshopEntryHref}
                        className="block rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 p-4 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
                      >
                        <p className="text-sm font-medium text-slate-900 dark:text-white">进入场景输出</p>
                      </Link>
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-3xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-5 sm:p-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">项目文件</p>
                        <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">项目文件</h2>
                        <p className="mt-1 text-xs text-slate-500">
                          上传需求说明、素材等；图片可用「图片 OCR」快速转为 Markdown 文字入库。
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-stretch justify-end gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="hidden"
                          onChange={handleAttachmentFileChange}
                        />
                        <input
                          ref={imageOcrInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleImageOcrFileChange}
                        />
                        <button
                          type="button"
                          onClick={openPasteTextModal}
                          disabled={attachmentUploading || attachmentOcrUploading}
                          className="rounded-xl border border-slate-300 bg-white/90 px-4 py-2 text-sm font-medium text-slate-800 transition hover:border-slate-400 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900/60 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          粘贴说明文字
                        </button>
                        <button
                          type="button"
                          onClick={handlePickImageOcr}
                          disabled={attachmentUploading || attachmentOcrUploading}
                          className="rounded-xl border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-800 transition hover:border-violet-400 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-200 dark:hover:bg-violet-500/20"
                        >
                          {attachmentOcrUploading ? "识别中…" : "图片 OCR"}
                        </button>
                        <button
                          type="button"
                          onClick={handlePickAttachment}
                          disabled={attachmentUploading || attachmentOcrUploading}
                          className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-800 transition hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
                        >
                          {attachmentUploading ? "上传中…" : "上传附件"}
                        </button>
                      </div>
                    </div>
                    {attachmentError ? (
                      <p className="mt-3 text-sm text-red-400">{attachmentError}</p>
                    ) : null}
                    {attachments.length === 0 ? (
                      <div className="mt-4">
                        <EmptyState
                          icon="📎"
                          title="暂无附件"
                          description="点击「上传附件」添加项目相关文件。"
                        />
                      </div>
                    ) : (
                      <ul className="mt-4 max-h-56 space-y-2 overflow-y-auto pr-1">
                        {attachments.map((a) => (
                          <li
                            key={a.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 px-3 py-2.5 text-sm"
                          >
                            <button
                              type="button"
                              onClick={() => setPreviewAttachment(a)}
                              className="min-w-0 flex-1 rounded-xl text-left transition hover:bg-slate-100/80 dark:hover:bg-slate-800/50"
                            >
                              <p
                                className="truncate font-semibold text-slate-900 dark:text-slate-100"
                                title={a.original_filename}
                              >
                                {a.original_filename}
                              </p>
                              <p className="text-xs text-slate-500">
                                {formatFileSize(a.size_bytes)} · {formatDateTimeShanghai(a.created_at)}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className={kbIngestBadgeClass(a.ingest_status)}>
                                  {kbIngestStatusLabel(a.ingest_status)}
                                </span>
                                {a.ingest_error ? (
                                  <span className="text-xs text-red-400/90 truncate max-w-[12rem]" title={a.ingest_error}>
                                    {a.ingest_error.slice(0, 80)}
                                  </span>
                                ) : null}
                              </div>
                            </button>
                            <div className="flex shrink-0 items-center gap-2">
                              {(a.ingest_status || "").toLowerCase() === "failed" ? (
                                <button
                                  type="button"
                                  onClick={() => void handleReingestAttachment(a.id)}
                                  className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900 transition hover:bg-amber-100 dark:border-amber-700/50 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-950/30"
                                >
                                  重试入库
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void handleDeleteAttachment(a.id)}
                                className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-xs text-red-900 transition hover:bg-red-100 dark:border-red-900/50 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40"
                              >
                                删除
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="rounded-3xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-5 sm:p-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">最新输出</p>
                        <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">最近输出沉淀</h2>
                        <p className="mt-1 text-xs text-slate-500">点击条目可在「输出沉淀」中查看全文</p>
                      </div>
                      {outputs.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setActiveTab("outputs")}
                          className="shrink-0 text-xs font-medium text-blue-600 transition hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                        >
                          查看全部 {outputs.length} 条 →
                        </button>
                      ) : null}
                    </div>
                    {recentOutputs.length === 0 ? (
                      <EmptyState
                        icon="📝"
                        title="暂无输出物"
                        description="从编排、对话或工坊生成后将显示在此。"
                      />
                    ) : (
                      <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
                        {recentOutputs.map((output) => (
                          <ProjectOutputCard
                            key={output.id}
                            output={output}
                            selected={false}
                            onSelect={() => openOutputFromQuickAccess(output)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "outputs" && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <MetricCard label="总输出数" value={String(outputs.length)} hint="已回收结果" />
                  <MetricCard
                    label="对话类"
                    value={String(outputsByDepositGroup.chat.length)}
                    hint="对话创作沉淀"
                  />
                  <MetricCard
                    label="文件类"
                    value={String(outputsByDepositGroup.file.length)}
                    hint="场景输出交付物"
                  />
                </div>

                {outputsLoadError ? (
                  <div className="rounded-2xl border border-amber-400/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-600/50 dark:bg-amber-950/40 dark:text-amber-200">
                    <p className="font-medium">输出列表加载失败</p>
                    <p className="mt-1 text-xs leading-relaxed opacity-90">{outputsLoadError}</p>
                  </div>
                ) : null}

                {outputs.length === 0 ? (
                  <div className="py-16 text-center text-slate-500">
                    <p className="mb-3 text-4xl">📝</p>
                    <p>暂无输出记录</p>
                    <p className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                      对话创作不会自动写入此处，需在助手消息上点击「存入项目」；场景输出 / 工坊执行成功后会自动沉淀为文件类输出；项目共创中 Agent
                      创建的文件也会出现在此。已归档的输出不在列表中显示。
                    </p>
                    <Link
                      href={`/workshop?project_id=${id}`}
                      className="mt-4 inline-block text-sm text-blue-400 hover:text-blue-300"
                    >
                      前往输出工坊生成 →
                    </Link>
                  </div>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                    <div className="min-w-0 space-y-6">
                      {OUTPUT_DEPOSIT_GROUPS.map((group) => {
                        const items = outputsByDepositGroup[group.key];
                        return (
                          <section key={group.key} className="space-y-3">
                            <div className="flex flex-wrap items-end justify-between gap-2">
                              <div>
                                <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
                                  <span>{group.icon}</span>
                                  {group.title}
                                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-normal text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                    {items.length}
                                  </span>
                                </h3>
                                <p className="mt-1 text-xs text-slate-500">{group.description}</p>
                              </div>
                            </div>
                            {items.length === 0 ? (
                              <div className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700">
                                {group.key === "chat" ? "暂无对话类输出" : "暂无文件类输出"}
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {items.map((output) => (
                                  <ProjectOutputCard
                                    key={output.id}
                                    output={output}
                                    selected={selectedOutput?.id === output.id}
                                    onSelect={() => {
                                      trackUsage({
                                        eventName: "project_output_open",
                                        feature: "projects_outputs",
                                        action: "open_output",
                                        projectId: id ? String(id) : undefined,
                                        properties: { output_id: output.id, deposit_group: group.key },
                                      });
                                      setSelectedOutput(output);
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                          </section>
                        );
                      })}
                    </div>

                    <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
                      {selectedOutput ? (
                        <ProjectOutputDetailPanel
                          output={selectedOutput}
                          outputFullContent={outputFullContent}
                          outputDetailLoading={outputDetailLoading}
                          copied={copied}
                          outputActionLinks={outputActionLinks}
                          outputGovernBusy={outputGovernBusy}
                          onCopy={() => handleCopy(outputFullContent ?? selectedOutput.content)}
                          onClose={() => setSelectedOutput(null)}
                          onArchive={() => void handleArchiveProjectOutput()}
                        />
                      ) : (
                        <div className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-100/50 p-6 text-center dark:border-slate-700 dark:bg-slate-900/30">
                          <p className="text-3xl">📄</p>
                          <p className="mt-3 text-sm font-medium text-slate-700 dark:text-slate-300">
                            选择一条输出查看详情
                          </p>
                          <p className="mt-1 text-xs text-slate-500">点击左侧列表中的输出物，全文与操作将显示于此</p>
                        </div>
                      )}
                    </aside>
                  </div>
                )}
              </div>
            )}

            {canViewRuns && activeTab === "runs" && (
              <div className="space-y-3">
                {runs.length === 0 ? (
                  <div className="py-16 text-center text-slate-500">
                    <p className="mb-3 text-4xl">📊</p>
                    <p>暂无编排执行记录</p>
                    <p className="mt-2 text-xs text-slate-600">
                      在对话或工坊通过 `/tasks/execute` 成功执行后将在此展示
                    </p>
                  </div>
                ) : (
                  runs.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-5 text-sm"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <code className="text-xs text-slate-400 break-all">{r.id}</code>
                        <span className="shrink-0 text-xs text-slate-500">
                          {formatDateTimeShanghai(r.created_at)}
                        </span>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded bg-slate-300 dark:bg-slate-700 px-2 py-0.5 text-slate-800 dark:text-slate-200">
                          {entrypointLabel(r.entrypoint)}
                        </span>
                        <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
                          {runStatusLabel(r.status)}
                        </span>
                        {r.duration_ms != null && (
                          <span className="text-slate-500">耗时 {r.duration_ms} 毫秒</span>
                        )}
                        {r.execution_mode && (
                          <span className="rounded bg-violet-50 px-2 py-0.5 text-violet-800 dark:bg-violet-900/30 dark:text-violet-200">
                            {r.execution_mode === "agent" ? "Agent" : "直连"}
                            {r.tool_capture_hit ? " · 工具产出" : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "members" && (
              <ProjectMembersPanel projectId={project.id} myRole={project.my_role} embedded />
            )}

            {activeTab === "feedback" && (
              <Feedback
                skillId={`project-${id}`}
                skillName={project.name}
              />
            )}

            <AttachmentPreviewModal
              open={Boolean(previewAttachment)}
              projectId={String(id)}
              attachment={previewAttachment}
              onClose={() => setPreviewAttachment(null)}
            />

            {pasteTextOpen && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="paste-text-title"
                  className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 shadow-xl"
                >
                  <div className="flex items-center justify-between border-b border-slate-300 dark:border-slate-700 px-4 py-3 sm:px-5">
                    <h2 id="paste-text-title" className="text-lg font-semibold text-slate-900 dark:text-white">
                      粘贴说明文字
                    </h2>
                    <button
                      type="button"
                      onClick={() => setPasteTextOpen(false)}
                      disabled={pasteTextSaving}
                      className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-300 dark:bg-slate-700 hover:text-slate-900 dark:hover:text-white disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
                    <p className="text-xs text-slate-500">
                      粘贴需求说明、背景材料等文字，保存后以 Markdown 附件入库（命名：项目名_日期_用户ID前8位.md）
                    </p>
                    <textarea
                      value={pasteTextContent}
                      onChange={(e) => setPasteTextContent(e.target.value)}
                      rows={12}
                      placeholder="在此粘贴说明文字…"
                      className={`${editInputCls} resize-y min-h-[12rem]`}
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-3 border-t border-slate-300 dark:border-slate-700 px-4 py-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => void handleSavePasteText()}
                      disabled={pasteTextSaving || !pasteTextContent.trim()}
                      className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                    >
                      {pasteTextSaving ? "保存中…" : "保存为附件"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPasteTextOpen(false)}
                      disabled={pasteTextSaving}
                      className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}

            {editOpen && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-project-title"
                  className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 shadow-xl"
                >
                  <form onSubmit={submitEditProject} className="flex flex-col overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-300 dark:border-slate-700 px-4 py-3 sm:px-5">
                      <h2 id="edit-project-title" className="text-lg font-semibold text-slate-900 dark:text-white">
                        编辑项目
                      </h2>
                      <button
                        type="button"
                        onClick={() => setEditOpen(false)}
                        className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-300 dark:bg-slate-700 hover:text-slate-900 dark:hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
                      {editError ? (
                        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300">
                          {editError}
                        </p>
                      ) : null}
                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">
                          项目名称 <span className="text-red-400">*</span>
                        </label>
                        <input
                          type="text"
                          value={editForm.name}
                          onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                          className={editInputCls}
                          required
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">项目状态</label>
                        <select
                          value={editForm.status}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              status: e.target.value as Project["status"],
                            }))
                          }
                          className={editInputCls}
                        >
                          {(Object.keys(statusLabels) as Project["status"][]).map((key) => (
                            <option key={key} value={key}>
                              {statusLabels[key]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">项目背景</label>
                        <textarea
                          value={editForm.background}
                          onChange={(e) => setEditForm((f) => ({ ...f, background: e.target.value }))}
                          rows={3}
                          className={`${editInputCls} resize-none`}
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-400">目标受众</label>
                          <input
                            type="text"
                            value={editForm.audience}
                            onChange={(e) => setEditForm((f) => ({ ...f, audience: e.target.value }))}
                            className={editInputCls}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-medium text-slate-400">截止日期</label>
                          <input
                            type="text"
                            value={editForm.deadline}
                            onChange={(e) => setEditForm((f) => ({ ...f, deadline: e.target.value }))}
                            placeholder="如 2026-12-31"
                            className={editInputCls}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">
                          约束条件（JSON 或纯文本）
                        </label>
                        <textarea
                          value={editForm.constraints}
                          onChange={(e) => setEditForm((f) => ({ ...f, constraints: e.target.value }))}
                          rows={5}
                          className={`${editInputCls} resize-none font-mono text-xs`}
                          placeholder='{} 或 {"key":"value"}'
                        />
                      </div>
                    </div>
                    <div className="flex gap-3 border-t border-slate-300 dark:border-slate-700 px-4 py-3 sm:px-5">
                      <button
                        type="submit"
                        disabled={editSaving}
                        className="flex-1 rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                      >
                        {editSaving ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditOpen(false)}
                        className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:bg-slate-300 dark:bg-slate-700"
                      >
                        取消
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function ActionLink({
  href,
  title,
  desc,
}: {
  href: string;
  title: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 p-4 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
    >
      <p className="text-sm font-medium text-slate-900 dark:text-white">{title}</p>
      {desc ? <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p> : null}
    </Link>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/30 px-6 text-center">
      <p className="text-4xl">{icon}</p>
      <p className="mt-3 text-sm font-medium text-slate-800 dark:text-slate-200">{title}</p>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-500">{description}</p>
    </div>
  );
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wider text-slate-400">{label}</p>
      {children}
    </div>
  );
}
