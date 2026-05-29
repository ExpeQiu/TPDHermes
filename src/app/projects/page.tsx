"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiDelete, apiGet } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { projectStatusLabel } from "@/lib/ui-labels";

interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "archived";
  deadline: string | null;
  background: string | null;
}

const statusColors: Record<string, string> = {
  active: "bg-blue-600",
  paused: "bg-yellow-500",
  completed: "bg-green-600",
  archived: "bg-slate-500",
};

const statusLabels: Record<Project["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "未设置";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("zh-CN");
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Project[]>("/projects/")
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <header className="mb-6 lg:mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            项目入口页
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">项目中心</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
                管理项目并进入对话创作与场景输出（推荐先打开项目详情）。
              </p>
            </div>
            <Link
              href="/projects/new"
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              + 新建项目
            </Link>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(15rem,18rem)_1fr] xl:grid-cols-[minmax(17rem,20rem)_1fr] lg:items-start">
          <aside className="lg:sticky lg:top-20 lg:z-10">
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-5 sm:p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">快捷入口</p>
              <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-white xl:text-xl">常用操作</h2>
              <div className="mt-4 grid grid-cols-1 gap-3">
                <ActionCard
                  href="/projects/new"
                  title="新建项目"
                  desc=""
                  accent="from-blue-600 to-indigo-600"
                  compact
                />
                <ActionCard
                  href="/chat"
                  title="对话创作"
                  desc=""
                  accent="from-emerald-600 to-teal-600"
                  compact
                />
                <ActionCard
                  href="/workshop"
                  title="场景输出"
                  desc=""
                  accent="from-amber-600 to-orange-600"
                  compact
                />
                <ActionCard
                  href="/create"
                  title="场景编排"
                  desc=""
                  accent="from-sky-600 to-blue-500"
                  compact
                />
              </div>
            </div>
          </aside>

          <section className="min-w-0 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-5 sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">项目列表</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">项目列表</h2>
            </div>
          </div>

          {loading && <p className="py-12 text-center text-slate-400">加载中...</p>}

          {error && (
            <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
              加载失败: {error}
            </div>
          )}

          {!loading && !error && projects.length === 0 && (
            <div className="py-16 text-center text-slate-500">
              <p className="mb-3 text-4xl">📁</p>
              <p>暂无项目</p>
              <p className="mt-2 text-sm text-slate-600">
                先新建项目，再从项目页进入对话创作或场景输出。
              </p>
            </div>
          )}

          {!loading && !error && projects.length > 0 && (
            <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {opError ? (
                <div className="col-span-full rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/80 dark:bg-amber-900/20 dark:text-amber-100">
                  {opError}
                </div>
              ) : null}
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="relative rounded-3xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-5 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200/80 dark:bg-slate-800/80"
                >
                  <Link
                    href={`/projects/${project.id}`}
                    className="absolute inset-0 z-0 rounded-3xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500/70"
                    aria-label={`${project.name}，进入项目控制台`}
                    tabIndex={0}
                  />
                  <div className="pointer-events-none relative z-10 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="text-xl font-semibold text-slate-900 dark:text-white">
                          {project.name}
                        </span>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium text-slate-900 dark:text-white ${
                            statusColors[project.status] ?? "bg-slate-500"
                          }`}
                        >
                          {projectStatusLabel(project.status)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm leading-relaxed text-slate-400">
                        {project.background || "暂无背景描述"}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
                        <span className="rounded-full border border-slate-300 dark:border-slate-700 px-2.5 py-1">
                          截止日期：{formatDate(project.deadline)}
                        </span>
                        <span className="rounded-full border border-slate-300 dark:border-slate-700 px-2.5 py-1">
                          项目中心
                        </span>
                      </div>
                    </div>

                    <div className="relative z-20 grid min-w-[16rem] gap-2 sm:grid-cols-2 lg:grid-cols-1">
                      <span className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/70 px-4 py-2.5 text-center text-sm font-medium text-slate-800 dark:text-slate-200">
                        项目控制台
                      </span>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-2">
                        <Link
                          href={`/workshop?project_id=${project.id}`}
                          className="pointer-events-auto relative z-20 rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 px-4 py-2.5 text-center text-sm text-slate-700 dark:text-slate-300 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
                        >
                          场景输出
                        </Link>
                        <Link
                          href={`/chat?project_id=${project.id}`}
                          className="pointer-events-auto relative z-20 rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 px-4 py-2.5 text-center text-sm text-slate-700 dark:text-slate-300 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
                        >
                          对话创作
                        </Link>
                      </div>
                      <button
                        type="button"
                        disabled={deletingId === project.id}
                        className="pointer-events-auto relative z-20 rounded-xl border border-red-300 bg-red-100 px-4 py-2 text-center text-sm text-red-900 transition hover:border-red-400 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200 dark:hover:border-red-700 dark:hover:bg-red-950/70"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (
                            !confirm(
                              `确定删除项目「${project.name}」？关联场景绑定、附件记录等将一并清理，不可恢复。`,
                            )
                          ) {
                            return;
                          }
                          setOpError(null);
                          setDeletingId(project.id);
                          try {
                            await apiDelete(`/projects/${project.id}`);
                            setProjects((prev) => prev.filter((p) => p.id !== project.id));
                          } catch (err) {
                            setOpError(
                              err instanceof Error ? err.message : "删除失败",
                            );
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                      >
                        {deletingId === project.id ? "删除中…" : "删除项目"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        </div>
      </div>
    </main>
  );
}

function ActionCard({
  href,
  title,
  desc,
  accent,
  compact,
}: {
  href: string;
  title: string;
  desc: string;
  accent: string;
  compact?: boolean;
}) {
  const pad = compact ? "p-4" : "p-5";
  const titleMt = compact ? "mt-3" : "mt-4";
  const linkMt = compact ? "mt-3" : "mt-4";
  return (
    <Link
      href={href}
      className={`group block rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 ${pad} transition hover:-translate-y-0.5 hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200/80 dark:hover:bg-slate-900/80`}
    >
      <div className={`h-1.5 w-10 rounded-full bg-gradient-to-r ${accent}`} aria-hidden />
      <p className={`${titleMt} text-sm font-semibold text-slate-900 dark:text-white sm:text-base`}>{title}</p>
      {desc ? <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p> : null}
      <span
        className={`${linkMt} inline-flex items-center gap-1 text-xs font-medium text-blue-400 transition group-hover:text-blue-300 sm:text-sm`}
      >
        进入
        <span aria-hidden>→</span>
      </span>
    </Link>
  );
}
