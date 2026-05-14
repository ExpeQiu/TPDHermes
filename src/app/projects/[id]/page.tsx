"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Feedback from "@/components/Feedback";
import { apiGet } from "@/lib/api";

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
}

function mapApiOutput(o: ApiOutputRow): ProjectOutput {
  const body = [o.summary, o.content_preview].filter(Boolean).join("\n\n") || "";
  const tags = [
    o.status,
    o.template_id ? `模板:${o.template_id}` : null,
    o.run_id ? `run:${o.run_id.slice(0, 8)}` : null,
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
  };
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

function summarizeConstraints(constraints: unknown): string[] {
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) return [];
  return Object.entries(constraints as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join(" / ")}`;
      if (value && typeof value === "object") return `${key}: 已配置`;
      return `${key}: ${String(value)}`;
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

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiGet<Project>(`/projects/${String(id)}`),
      apiGet<ApiOutputRow[]>(`/projects/${String(id)}/outputs`).catch(() => [] as ApiOutputRow[]),
      apiGet<ApiRunRow[]>(`/projects/${String(id)}/runs`).catch(() => [] as ApiRunRow[]),
    ])
      .then(([proj, outRows, runRows]) => {
        if (!cancelled) {
          setProject(proj);
          setOutputs(outRows.map(mapApiOutput));
          setRuns(runRows);
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
        if (!cancelled) setOutputFullContent(d.content);
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

  const totalWords = outputs.reduce((sum, o) => sum + o.word_count, 0);
  const latestOutput = outputs[0];
  const latestRun = runs[0];
  const templateTags = Array.from(
    new Set(
      outputs.flatMap((output) =>
        output.tags.filter((tag) => tag.startsWith("模板:")).map((tag) => tag.replace(/^模板:/, "")),
      ),
    ),
  ).slice(0, 4);
  const constraintHighlights = summarizeConstraints(project?.constraints);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className="mx-auto max-w-6xl">
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
                <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400">
                  以项目为中心查看任务边界、输出沉淀和执行记录，让工作流配置与结果资产处于同一视图。
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <span
                  className={`self-start rounded-full px-3 py-1 text-xs font-medium text-white sm:text-sm ${statusColors[project.status] ?? "bg-slate-500"}`}
                >
                  {statusLabels[project.status] ?? project.status}
                </span>
                <Link
                  href={`/create?project=${id}`}
                  className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-200 transition hover:border-blue-400 hover:bg-blue-500/20"
                >
                  发起场景编排
                </Link>
                <Link
                  href={`/chat?project=${id}`}
                  className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
                >
                  进入对话协作
                </Link>
              </div>
            </div>

            <div className="mb-6 grid gap-3 md:grid-cols-4">
              <MetricCard label="输出物" value={String(outputs.length)} hint="已沉淀结果" />
              <MetricCard label="执行记录" value={String(runs.length)} hint="统一任务链路" />
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
                      <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                        {statusLabels[project.status] ?? project.status}
                      </span>
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
                        href={`/create?project=${id}`}
                        title="发起场景编排"
                        desc="从场景、知识和期望输出生成一份任务合同。"
                      />
                      <ActionLink
                        href={`/chat?project=${id}`}
                        title="继续对话协作"
                        desc="围绕当前项目做需求澄清、执行和迭代。"
                      />
                      <ActionLink
                        href={`/workshop?project=${id}`}
                        title="进入结果工坊"
                        desc="基于已有输出继续优化、扩写和定向生成。"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-4">
                  <PolicyCard
                    title="技术与业务边界"
                    description="当前项目沉淀了长期生效的业务上下文，可作为后续场景编排的默认边界。"
                    tags={constraintHighlights.length > 0 ? constraintHighlights : ["建议补充结构化约束"]}
                  />
                  <PolicyCard
                    title="知识范围"
                    description="知识范围应跟随项目或任务配置，而不是由前端临时拼接为上下文文本。"
                    tags={
                      latestRun
                        ? ["已有执行记录", "可在场景编排中指定集合"]
                        : ["尚未沉淀知识策略", "建议从场景编排入口补全"]
                    }
                  />
                  <PolicyCard
                    title="模板策略"
                    description="模板是输出合同的一部分，建议按项目默认模板和场景临时覆盖共同管理。"
                    tags={templateTags.length > 0 ? templateTags : ["暂无模板沉淀", "后续可接入模板中心"]}
                  />
                  <PolicyCard
                    title="结果闭环"
                    description="项目控制台统一承接输出物与执行记录，让内容生成具备回看和复用能力。"
                    tags={[
                      outputs.length > 0 ? `输出 ${outputs.length} 条` : "暂无输出",
                      runs.length > 0 ? `执行 ${runs.length} 次` : "暂无执行",
                    ]}
                  />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
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
                        description="从场景编排、对话协作或结果工坊发起一次生成后，这里会展示最近沉淀的内容。"
                      />
                    )}
                  </div>

                  <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5 sm:p-6">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Latest Run</p>
                    <h2 className="mt-2 text-xl font-semibold text-white">最近执行记录</h2>
                    {latestRun ? (
                      <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-slate-700 px-2.5 py-1 text-xs text-slate-200">
                            {latestRun.entrypoint}
                          </span>
                          <span className="rounded-full bg-blue-900/40 px-2.5 py-1 text-xs text-blue-200">
                            {latestRun.status}
                          </span>
                          {latestRun.duration_ms != null && (
                            <span className="text-xs text-slate-500">
                              耗时 {latestRun.duration_ms} ms
                            </span>
                          )}
                        </div>
                        <p className="mt-3 break-all text-xs text-slate-500">{latestRun.id}</p>
                        <p className="mt-2 text-sm text-slate-300">
                          记录时间：{formatDate(latestRun.created_at)}
                        </p>
                      </div>
                    ) : (
                      <EmptyState
                        icon="📊"
                        title="暂无执行链路"
                        description="当前项目尚未通过统一任务入口产生执行记录，可从编排页或对话页开始一次任务。"
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
                    <Link href="/workshop" className="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300">
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
                              <p className="text-xs text-slate-500">
                                {selectedOutput.skill_name} · {formatDate(selectedOutput.created_at)}
                              </p>
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
                      <div className="p-4 border-t border-slate-700 flex gap-3">
                        <Link
                          href={`/workshop?project=${id}`}
                          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-center transition"
                        >
                          基于此优化
                        </Link>
                        <button
                          onClick={() => setSelectedOutput(null)}
                          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition"
                        >
                          关闭
                        </button>
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
                      <p className="mt-3 text-slate-400">
                        当前执行记录已纳入项目维度，可与输出沉淀一起构成完整的任务闭环。
                      </p>
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

function PolicyCard({
  title,
  description,
  tags,
}: {
  title: string;
  description: string;
  tags: string[];
}) {
  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-800/50 p-5">
      <p className="text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300"
          >
            {tag}
          </span>
        ))}
      </div>
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
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
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
