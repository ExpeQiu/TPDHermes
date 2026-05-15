"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Feedback from "@/components/Feedback";
import { apiGet, apiV1, apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "archived";
  deadline: string | null;
  background: string | null;
  audience: string | null;
  constraints: unknown;
}

const statusColors: Record<string, string> = {
  active: "bg-blue-600",
  paused: "bg-yellow-500",
  completed: "bg-green-600",
  archived: "bg-slate-500",
};

const outputStatusLabels: Record<string, string> = {
  draft: "草稿",
  completed: "已完成",
  approved: "已批准",
  archived: "已归档",
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
  status: string;
  created_at: string | null;
  content_preview: string;
}

interface ApiRunRow {
  id: string;
  entrypoint: string;
  status: string;
  created_at: string | null;
  duration_ms: number | null;
}

interface ApiOutputDetail {
  id: string;
  project_id: string;
  title: string | null;
  summary: string | null;
  content: string;
  template_id: string | null;
  run_id: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  content_format: string;
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
  status: string;
}

function mapApiOutput(o: ApiOutputRow): ProjectOutput {
  const body = [o.summary, o.content_preview].filter(Boolean).join("\n\n") || "";
  const tags = [
    o.status,
    o.template_id ? `模板:${o.template_id}` : null,
    o.run_id ? `run:${o.run_id.slice(0, 8)}` : null,
    o.scenario_id ? `场景:${o.scenario_id.slice(0, 8)}` : null,
  ].filter(Boolean) as string[];
  return {
    id: o.id,
    skill_name: "编排输出",
    skill_icon: "📋",
    title: o.title ?? "输出物",
    content: body,
    created_at: o.created_at ?? "",
    word_count: body.replace(/\s/g, "").length,
    tags,
    scenario_id: o.scenario_id ?? null,
    status: o.status || "draft",
  };
}

interface ApiAttachmentRow {
  id: string;
  project_id: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string | null;
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

type ScenarioCatalogRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
};

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

function formatDate(value: string | null | undefined) {
  if (!value) return "未记录";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ProjectDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [outputs, setOutputs] = useState<ProjectOutput[]>([]);
  const [runs, setRuns] = useState<ApiRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "outputs" | "runs" | "feedback">("info");
  const [selectedOutput, setSelectedOutput] = useState<ProjectOutput | null>(null);
  const [copied, setCopied] = useState(false);
  const [outputFullContent, setOutputFullContent] = useState<string | null>(null);
  const [outputDetailLoading, setOutputDetailLoading] = useState(false);
  const [attachments, setAttachments] = useState<ApiAttachmentRow[]>([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [outputGovernBusy, setOutputGovernBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const [bindSelectId, setBindSelectId] = useState("");
  const [bindBusy, setBindBusy] = useState(false);
  const [boundScenarios, setBoundScenarios] = useState<ProjectBoundScenario[]>([]);
  const [boundLoading, setBoundLoading] = useState(false);
  const [catalogScenarios, setCatalogScenarios] = useState<ScenarioCatalogRow[]>([]);

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
    const outRows = await apiGet<ApiOutputRow[]>(`/projects/${String(id)}/outputs`).catch(
      () => [] as ApiOutputRow[],
    );
    const mapped = outRows.map(mapApiOutput);
    setOutputs(mapped);
    return mapped;
  }, [id]);

  const bindableScenarios = useMemo(() => {
    const boundIds = new Set(boundScenarios.map((b) => b.scenario_id));
    return catalogScenarios.filter((s) => {
      if (boundIds.has(s.id)) return false;
      const st = (s.status || "draft").toLowerCase();
      return st === "published";
    });
  }, [catalogScenarios, boundScenarios]);

  useEffect(() => {
    if (!id) return;
    void refreshBoundScenarios();
  }, [id, refreshBoundScenarios]);

  useEffect(() => {
    apiGet<ScenarioCatalogRow[]>("/scenarios/")
      .then(setCatalogScenarios)
      .catch(() => setCatalogScenarios([]));
  }, []);

  const setDefaultBoundScenario = async (scenarioId: string) => {
    if (!id) return;
    try {
      const res = await apiFetch(`/projects/${String(id)}/scenarios/${scenarioId}/default`, {
        method: "POST",
      });
      await readJson(res);
      await refreshBoundScenarios();
    } catch (err) {
      alert(err instanceof Error ? err.message : "设置默认失败");
    }
  };

  const unbindScenario = async (scenarioId: string) => {
    if (!id || !window.confirm("确定解除该场景绑定？")) return;
    try {
      const res = await apiFetch(`/projects/${String(id)}/scenarios/${scenarioId}`, {
        method: "DELETE",
      });
      await readJson<{ message?: string }>(res);
      await refreshBoundScenarios();
    } catch (eff) {
      alert(eff instanceof Error ? eff.message : "解绑失败");
    }
  };

  const bindScenarioToProject = async () => {
    if (!id || !bindSelectId) {
      alert("请选择要绑定的场景");
      return;
    }
    const row = catalogScenarios.find((s) => s.id === bindSelectId);
    if (!row) return;
    setBindBusy(true);
    try {
      const res = await apiFetch(`/projects/${String(id)}/scenarios`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: row.id,
          scenario_version: row.version,
          is_default: boundScenarios.filter((b) => b.enabled === 1).length === 0,
        }),
      });
      await readJson(res);
      setBindSelectId("");
      await refreshBoundScenarios();
    } catch (err) {
      alert(err instanceof Error ? err.message : "绑定失败");
    } finally {
      setBindBusy(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiGet<Project>(`/projects/${String(id)}`),
      apiGet<ApiOutputRow[]>(`/projects/${String(id)}/outputs`).catch(() => [] as ApiOutputRow[]),
      apiGet<ApiRunRow[]>(`/projects/${String(id)}/runs`).catch(() => [] as ApiRunRow[]),
      apiGet<ApiAttachmentRow[]>(`/projects/${String(id)}/attachments`).catch(
        () => [] as ApiAttachmentRow[],
      ),
    ])
      .then(([proj, outRows, runRows, attachRows]) => {
        if (!cancelled) {
          setProject(proj);
          setOutputs(outRows.map(mapApiOutput));
          setRuns(runRows);
          setAttachments(attachRows);
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
          prev && prev.id === d.id ? { ...prev, status: d.status } : prev,
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

  const handleApproveProjectOutput = async () => {
    if (!id || !selectedOutput) return;
    setOutputGovernBusy(true);
    try {
      const res = await apiFetch(`/projects/${String(id)}/outputs/${selectedOutput.id}/approve`, {
        method: "POST",
      });
      await readJson(res);
      const mapped = await refreshOutputs();
      const next = mapped.find((o) => o.id === selectedOutput.id);
      if (next) setSelectedOutput(next);
      console.info("[project] 输出已批准", { project_id: id, output_id: selectedOutput.id });
    } catch (e) {
      alert(e instanceof Error ? e.message : "批准失败");
    } finally {
      setOutputGovernBusy(false);
    }
  };

  const handleArchiveProjectOutput = async () => {
    if (!id || !selectedOutput) return;
    setOutputGovernBusy(true);
    try {
      const res = await apiFetch(`/projects/${String(id)}/outputs/${selectedOutput.id}/archive`, {
        method: "POST",
      });
      await readJson(res);
      const mapped = await refreshOutputs();
      const next = mapped.find((o) => o.id === selectedOutput.id);
      if (next) setSelectedOutput(next);
      console.info("[project] 输出已归档", { project_id: id, output_id: selectedOutput.id });
    } catch (e) {
      alert(e instanceof Error ? e.message : "归档失败");
    } finally {
      setOutputGovernBusy(false);
    }
  };

  const handlePickAttachment = () => {
    setAttachmentError(null);
    fileInputRef.current?.click();
  };

  const handleAttachmentFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !id) return;
    setAttachmentUploading(true);
    setAttachmentError(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(apiV1(`/projects/${String(id)}/attachments`), {
        method: "POST",
        body: fd,
      });
      await readJson<ApiAttachmentRow>(res);
      await refreshAttachments();
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "上传失败");
    } finally {
      setAttachmentUploading(false);
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    if (!id || !window.confirm("确定删除该附件？")) return;
    setAttachmentError(null);
    try {
      const res = await fetch(apiV1(`/projects/${String(id)}/attachments/${attachmentId}`), {
        method: "DELETE",
      });
      await readJson<{ ok: boolean }>(res);
      await refreshAttachments();
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const attachmentDownloadUrl = (attachmentId: string) =>
    apiV1(`/projects/${String(id)}/attachments/${attachmentId}/download`);

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
    "w-full rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none";

  const totalWords = outputs.reduce((sum, o) => sum + o.word_count, 0);
  const latestOutput = outputs[0];
  const latestRun = runs[0];

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className={CONTENT_MAX_CLASS}>
        <Link
          href="/projects"
          className="mb-6 inline-flex items-center text-sm text-slate-400 transition hover:text-white"
        >
          ← 返回项目列表
        </Link>

        {loading && (
          <div className="space-y-4 animate-pulse">
            <div className="h-8 bg-slate-700 rounded w-1/2" />
            <div className="h-4 bg-slate-700 rounded w-full" />
            <div className="h-32 bg-slate-700 rounded" />
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300">
            加载失败: {error}
          </div>
        )}

        {project && (
          <>
            <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project Console</p>
                <h1 className="mt-2 text-2xl font-bold leading-tight sm:text-3xl md:text-4xl">
                  {project.name}
                </h1>
                <p className="mt-2 text-sm text-slate-400">项目 ID: #{project.id}</p>
              </div>
              <span
                className={`self-start rounded-full px-3 py-1 text-xs font-medium text-white sm:text-sm ${statusColors[project.status] ?? "bg-slate-500"}`}
              >
                {statusLabels[project.status] ?? project.status}
              </span>
            </div>

            <div className="mb-6 grid gap-3 md:grid-cols-4">
              <MetricCard label="输出物" value={String(outputs.length)} hint="已沉淀结果" />
              <MetricCard label="项目附件" value={String(attachments.length)} hint="上传的参考文件" />
              <MetricCard label="累计字数" value={totalWords.toLocaleString()} hint="输出沉淀体量" />
              <MetricCard
                label="最新活动"
                value={latestRun ? formatDate(latestRun.created_at) : "暂无"}
                hint={latestRun ? latestRun.status : "等待执行"}
              />
            </div>

            <div className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-700">
              {[
                { key: "info", label: "控制台" },
                { key: "outputs", label: "输出沉淀", badge: outputs.length },
                { key: "runs", label: "执行记录", badge: runs.length },
                { key: "feedback", label: "用户反馈" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                    activeTab === tab.key
                      ? "border-blue-500 text-white"
                      : "border-transparent text-slate-400 hover:text-white hover:border-slate-600"
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
                  <div className="space-y-4 rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                          Project Boundary
                        </p>
                        <h2 className="mt-2 text-xl font-semibold text-white">项目边界</h2>
                      </div>
                      <button
                        type="button"
                        onClick={openEditProject}
                        className="shrink-0 rounded-full border border-slate-600 bg-slate-900/80 px-3 py-1 text-xs font-medium text-slate-200 transition hover:border-blue-500/50 hover:bg-slate-800 hover:text-white"
                      >
                        编辑
                      </button>
                    </div>

                    <InfoField label="项目背景">
                      <p className="leading-relaxed text-slate-200">
                        {project.background || "暂无描述"}
                      </p>
                    </InfoField>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <InfoField label="目标受众">
                        <p className="text-slate-200">{project.audience || "未设置"}</p>
                      </InfoField>
                      <InfoField label="截止日期">
                        <p className="text-slate-200">{project.deadline || "未设置"}</p>
                      </InfoField>
                    </div>

                    <InfoField label="约束条件">
                      <pre className="overflow-x-auto whitespace-pre-wrap rounded-2xl bg-slate-900/70 p-4 text-sm leading-relaxed text-slate-300">
                        {project.constraints == null
                          ? "暂无约束条件"
                          : typeof project.constraints === "string"
                            ? project.constraints
                            : JSON.stringify(project.constraints, null, 2)}
                      </pre>
                    </InfoField>
                  </div>

                  <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                      Quick Actions
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-white">工作流入口</h2>
                    <div className="mt-5 space-y-3">
                      <ActionLink
                        href={`/chat?project_id=${id}`}
                        title="进入对话创作"
                        desc=""
                      />
                      <ActionLink
                        href={`/workshop?project_id=${id}`}
                        title="进入场景输出"
                        desc=""
                      />
                      <ActionLink href={`/create?return_project_id=${id}`} title="场景编排（全局维护）" desc="" />
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Scenario Bindings</p>
                      <h2 className="mt-2 text-xl font-semibold text-white">已绑定场景</h2>
                      <p className="mt-1 text-xs text-slate-500">
                        「场景输出」仅可选择此处已启用绑定。维护合同请用下方入口前往场景编排。
                      </p>
                    </div>
                    <Link
                      href={`/create?return_project_id=${id}`}
                      className="inline-flex shrink-0 items-center justify-center rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-xs font-medium text-slate-200 transition hover:border-blue-500/40 hover:text-white"
                    >
                      场景编排
                    </Link>
                  </div>
                  {boundLoading ? (
                    <p className="mt-4 text-sm text-slate-500">加载绑定列表…</p>
                  ) : boundScenarios.filter((b) => b.enabled === 1).length === 0 ? (
                    <p className="mt-4 text-sm text-amber-400/90">
                      尚未绑定可执行场景。请绑定或前往场景编排创建后回到本页添加绑定。
                    </p>
                  ) : (
                    <ul className="mt-4 space-y-2">
                      {boundScenarios
                        .filter((b) => b.enabled === 1)
                        .map((b) => {
                          const bindSt = (b.scenario_status || "draft").toLowerCase();
                          const workshopReady = bindSt === "published";
                          return (
                          <li
                            key={b.binding_id}
                            className="flex flex-col gap-2 rounded-2xl border border-slate-700 bg-slate-900/50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <p className="font-medium text-white">{b.scenario_name}</p>
                              <p className="mt-0.5 font-mono text-xs text-slate-500">
                                {b.scenario_code} · v{b.scenario_version} · {b.scenario_status}
                                {b.is_default === 1 ? " · 默认" : ""}
                              </p>
                              {!workshopReady ? (
                                <p className="mt-1 text-xs text-amber-400/90">
                                  场景输出不可选：需场景为 published；当前为 {b.scenario_status || "draft"}
                                  （请发布或解绑后重新绑定）
                                </p>
                              ) : null}
                              {b.scenario_description ? (
                                <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                                  {b.scenario_description}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              {b.is_default !== 1 ? (
                                <button
                                  type="button"
                                  onClick={() => void setDefaultBoundScenario(b.scenario_id)}
                                  className="rounded-lg border border-slate-600 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-slate-800"
                                >
                                  设为默认
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => void unbindScenario(b.scenario_id)}
                                className="rounded-lg border border-red-900/50 px-2.5 py-1 text-xs text-red-300 transition hover:bg-red-950/40"
                              >
                                解绑
                              </button>
                            </div>
                          </li>
                          );
                        })}
                    </ul>
                  )}
                  <div className="mt-4 space-y-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <label className="block flex-1 space-y-2 text-sm">
                        <span className="text-slate-400">绑定已有场景</span>
                        <select
                          value={bindSelectId}
                          onChange={(e) => setBindSelectId(e.target.value)}
                          className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
                        >
                          <option value="">选择场景…</option>
                          {bindableScenarios.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} · v{s.version} · {s.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={bindBusy || !bindSelectId}
                        onClick={() => void bindScenarioToProject()}
                        className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                      >
                        {bindBusy ? "绑定中…" : "添加绑定"}
                      </button>
                    </div>
                    {bindableScenarios.length === 0 && catalogScenarios.length > 0 ? (
                      <p className="text-xs text-slate-500">
                        下拉仅列出已发布（published）且未绑定的场景；草稿或停用场景请先在场景编排中发布。
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project Files</p>
                        <h2 className="mt-2 text-xl font-semibold text-white">项目文件</h2>
                        <p className="mt-1 text-xs text-slate-500">
                          上传需求说明、素材等，供编排与协作时参考。
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="hidden"
                          onChange={handleAttachmentFileChange}
                        />
                        <button
                          type="button"
                          onClick={handlePickAttachment}
                          disabled={attachmentUploading}
                          className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-200 transition hover:border-blue-400 hover:bg-blue-500/20 disabled:opacity-50"
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
                            className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium text-slate-100" title={a.original_filename}>
                                {a.original_filename}
                              </p>
                              <p className="text-xs text-slate-500">
                                {formatFileSize(a.size_bytes)} · {formatDate(a.created_at)}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <a
                                href={attachmentDownloadUrl(a.id)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded-lg border border-slate-600 px-2.5 py-1 text-xs text-slate-200 transition hover:bg-slate-700"
                              >
                                下载
                              </a>
                              <button
                                type="button"
                                onClick={() => void handleDeleteAttachment(a.id)}
                                className="rounded-lg border border-red-900/50 px-2.5 py-1 text-xs text-red-300 transition hover:bg-red-950/40"
                              >
                                删除
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Latest Output</p>
                    <h2 className="mt-2 text-xl font-semibold text-white">最近输出沉淀</h2>
                    {latestOutput ? (
                      <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-base font-medium text-white">{latestOutput.title}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              {formatDate(latestOutput.created_at)}
                            </p>
                          </div>
                          <span className="rounded-full bg-blue-500/10 px-2.5 py-1 text-xs text-blue-300">
                            {latestOutput.word_count.toLocaleString()} 字
                          </span>
                        </div>
                        <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-slate-400">
                          {latestOutput.content}
                        </p>
                      </div>
                    ) : (
                      <EmptyState
                        icon="📝"
                        title="暂无输出物"
                        description="从编排、对话或工坊生成后将显示在此。"
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "outputs" && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <MetricCard label="总输出数" value={String(outputs.length)} hint="已回收结果" />
                  <MetricCard label="累计字数" value={totalWords.toLocaleString()} hint="内容资产规模" />
                  <MetricCard
                    label="项目状态"
                    value={project.status === "active" ? "进行中" : statusLabels[project.status] ?? project.status}
                    hint="当前项目阶段"
                  />
                </div>

                {outputs.length === 0 ? (
                  <div className="py-16 text-center text-slate-500">
                    <p className="mb-3 text-4xl">📝</p>
                    <p>暂无输出记录</p>
                    <Link
                      href={`/workshop?project_id=${id}`} className="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300">
                      前往输出工坊生成 →
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {outputs.map((output) => (
                      <div
                        key={output.id}
                        onClick={() => setSelectedOutput(output)}
                        className={`cursor-pointer rounded-xl border bg-slate-800/60 p-4 transition hover:border-slate-600 ${
                          selectedOutput?.id === output.id ? "border-blue-500" : "border-slate-700"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="text-2xl shrink-0">{output.skill_icon}</span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <h3 className="font-medium text-sm sm:text-base truncate">{output.title}</h3>
                                <span className="shrink-0 text-xs text-slate-500">
                                  {formatDate(output.created_at)}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-1.5 mb-2">
                                {output.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="rounded bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400"
                                  >
                                    {tag}
                                  </span>
                                ))}
                                <span className="text-xs text-slate-500">{output.word_count.toLocaleString()} 字</span>
                              </div>
                              <p className="text-slate-400 text-xs line-clamp-2 leading-relaxed">
                                {output.content.slice(0, 120)}…
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Output Detail Modal */}
                {selectedOutput && (
                  <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
                      <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-700">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-2xl">{selectedOutput.skill_icon}</span>
                          <div className="min-w-0">
                            <h2 className="font-semibold text-sm sm:text-base truncate">{selectedOutput.title}</h2>
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <p className="text-xs text-slate-500">
                                {selectedOutput.skill_name} · {formatDate(selectedOutput.created_at)}
                              </p>
                              <span className="rounded bg-slate-700/80 px-2 py-0.5 text-[11px] font-medium text-slate-200">
                                {outputStatusLabels[selectedOutput.status] ?? selectedOutput.status}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          <button
                            onClick={() => handleCopy(outputFullContent ?? selectedOutput.content)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                              copied
                                ? "border-green-500/50 bg-green-500/10 text-green-400"
                                : "border-slate-600 bg-slate-700/60 text-slate-300 hover:bg-slate-700"
                            }`}
                          >
                            {copied ? "✓ 已复制" : "复制全文"}
                          </button>
                          <button
                            onClick={() => setSelectedOutput(null)}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                        <pre className="whitespace-pre-wrap text-slate-200 text-sm leading-relaxed font-mono">
                          {outputDetailLoading
                            ? "正在加载全文…"
                            : outputFullContent ?? selectedOutput.content}
                        </pre>
                      </div>
                      <div className="border-t border-slate-700 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                          <Link
                            href={`/workshop?project_id=${id}&scenario_id=${encodeURIComponent(selectedOutput.scenario_id || "")}&output_id=${selectedOutput.id}&mode=refine`}
                            className="flex-1 min-w-[10rem] px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-center transition"
                          >
                            基于此优化
                          </Link>
                          <button
                            type="button"
                            onClick={() => void handleApproveProjectOutput()}
                            disabled={
                              outputGovernBusy ||
                              selectedOutput.status === "approved" ||
                              selectedOutput.status === "archived"
                            }
                            className="px-4 py-2 rounded-lg text-sm font-medium border border-emerald-600/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25 transition disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            批准
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleArchiveProjectOutput()}
                            disabled={outputGovernBusy || selectedOutput.status === "archived"}
                            className="px-4 py-2 rounded-lg text-sm font-medium border border-amber-600/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 transition disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            归档
                          </button>
                          <button
                            type="button"
                            onClick={() => setSelectedOutput(null)}
                            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition sm:ml-auto"
                          >
                            关闭
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === "runs" && (
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
                      className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 text-sm"
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <code className="text-xs text-slate-400 break-all">{r.id}</code>
                        <span className="shrink-0 text-xs text-slate-500">
                          {formatDate(r.created_at)}
                        </span>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded bg-slate-700 px-2 py-0.5 text-slate-200">
                          {r.entrypoint}
                        </span>
                        <span className="rounded bg-blue-900/40 px-2 py-0.5 text-blue-200">
                          {r.status}
                        </span>
                        {r.duration_ms != null && (
                          <span className="text-slate-500">耗时 {r.duration_ms} ms</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "feedback" && (
              <Feedback
                skillId={`project-${id}`}
                skillName={project.name}
              />
            )}

            {editOpen && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="edit-project-title"
                  className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-xl"
                >
                  <form onSubmit={submitEditProject} className="flex flex-col overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3 sm:px-5">
                      <h2 id="edit-project-title" className="text-lg font-semibold text-white">
                        编辑项目
                      </h2>
                      <button
                        type="button"
                        onClick={() => setEditOpen(false)}
                        className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-700 hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
                      {editError ? (
                        <p className="rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
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
                    <div className="flex gap-3 border-t border-slate-700 px-4 py-3 sm:px-5">
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
                        className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-700"
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
    <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
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
      className="block rounded-2xl border border-slate-700 bg-slate-900/60 p-4 transition hover:border-slate-600 hover:bg-slate-900"
    >
      <p className="text-sm font-medium text-white">{title}</p>
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
    <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 px-6 text-center">
      <p className="text-4xl">{icon}</p>
      <p className="mt-3 text-sm font-medium text-slate-200">{title}</p>
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
