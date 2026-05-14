"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";

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

  const activeCount = projects.filter((project) => project.status === "active").length;
  const archivedCount = projects.filter((project) => project.status === "archived").length;
  const withDeadlineCount = projects.filter((project) => Boolean(project.deadline)).length;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            项目入口页
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">项目中心与任务入口</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
                这里不再只是项目列表，而是统一承接项目管理、场景编排、对话协作和结果工坊的入口页。项目作为长期边界，任务作为执行入口。
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

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          <MetricCard label="项目总数" value={String(projects.length)} hint="全部项目资产" />
          <MetricCard label="进行中" value={String(activeCount)} hint="可继续推进" />
          <MetricCard label="已设截止期" value={String(withDeadlineCount)} hint="带时间约束" />
          <MetricCard label="已归档" value={String(archivedCount)} hint="历史沉淀" />
        </section>

        <section className="mb-6 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Project Center</p>
            <h2 className="mt-2 text-xl font-semibold text-white">项目中心</h2>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <ActionCard
                href="/projects/new"
                title="创建项目"
                desc="沉淀背景、受众、约束和交付目标，让项目承担长期边界。"
                accent="from-blue-600 to-indigo-600"
              />
              <ActionCard
                href="/knowledge"
                title="查看知识策略"
                desc="浏览知识集合与检索状态，为项目后续的知识范围配置做准备。"
                accent="from-emerald-600 to-teal-600"
              />
              <ActionCard
                href="/skills"
                title="查看技能策略"
                desc="管理可复用技能资产，为任务执行提供白名单和偏好策略。"
                accent="from-amber-600 to-orange-600"
              />
              <ActionCard
                href="/create"
                title="直接发起编排"
                desc="如果暂时不绑定项目，也可以先从场景编排页定义本次任务合同。"
                accent="from-sky-600 to-blue-500"
              />
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Task Entry</p>
            <h2 className="mt-2 text-xl font-semibold text-white">任务入口说明</h2>
            <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-400">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">场景编排</p>
                <p className="mt-1">适合先定义任务边界、知识范围、输出目标，再进入执行。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">对话协作</p>
                <p className="mt-1">适合围绕同一任务持续澄清需求、追问和迭代。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">结果工坊</p>
                <p className="mt-1">适合在已有目标或已有稿件基础上继续优化和定向生成。</p>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Projects</p>
              <h2 className="mt-2 text-xl font-semibold text-white">项目列表</h2>
            </div>
            <p className="text-sm text-slate-500">进入项目后可继续发起编排、对话协作和结果工坊</p>
          </div>

          {loading && <p className="py-12 text-center text-slate-400">加载中...</p>}

          {error && (
            <div className="mt-6 rounded-lg border border-red-700 bg-red-900/30 p-4 text-red-300">
              加载失败: {error}
            </div>
          )}

          {!loading && !error && projects.length === 0 && (
            <div className="py-16 text-center text-slate-500">
              <p className="mb-3 text-4xl">📁</p>
              <p>暂无项目</p>
              <p className="mt-2 text-sm text-slate-600">
                先新建项目，或先从场景编排页直接发起一次任务。
              </p>
            </div>
          )}

          {!loading && !error && projects.length > 0 && (
            <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="rounded-3xl border border-slate-700 bg-slate-800/60 p-5 transition hover:border-slate-600 hover:bg-slate-800/80"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <Link
                          href={`/projects/${project.id}`}
                          className="text-xl font-semibold text-white transition hover:text-blue-300"
                        >
                          {project.name}
                        </Link>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium text-white ${
                            statusColors[project.status] ?? "bg-slate-500"
                          }`}
                        >
                          {statusLabels[project.status] ?? project.status}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm leading-relaxed text-slate-400">
                        {project.background || "暂无背景描述"}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
                        <span className="rounded-full border border-slate-700 px-2.5 py-1">
                          截止日期：{formatDate(project.deadline)}
                        </span>
                        <span className="rounded-full border border-slate-700 px-2.5 py-1">
                          项目中心
                        </span>
                      </div>
                    </div>

                    <div className="grid min-w-[16rem] gap-2 sm:grid-cols-3 lg:grid-cols-1">
                      <Link
                        href={`/projects/${project.id}`}
                        className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-center text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
                      >
                        项目控制台
                      </Link>
                      <Link
                        href={`/create?project=${project.id}`}
                        className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-center text-sm font-medium text-blue-200 transition hover:border-blue-400 hover:bg-blue-500/20"
                      >
                        发起编排
                      </Link>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-2">
                        <Link
                          href={`/chat?project=${project.id}`}
                          className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-center text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-900"
                        >
                          对话
                        </Link>
                        <Link
                          href={`/workshop?project=${project.id}`}
                          className="rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-2.5 text-center text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-900"
                        >
                          工坊
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
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
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function ActionCard({
  href,
  title,
  desc,
  accent,
}: {
  href: string;
  title: string;
  desc: string;
  accent: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-2xl border border-slate-800 bg-slate-950/60 p-5 transition hover:-translate-y-0.5 hover:border-slate-600 hover:bg-slate-900/80"
    >
      <div className={`h-1.5 w-12 rounded-full bg-gradient-to-r ${accent}`} aria-hidden />
      <p className="mt-4 text-base font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-400 transition group-hover:text-blue-300">
        进入
        <span aria-hidden>→</span>
      </span>
    </Link>
  );
}
