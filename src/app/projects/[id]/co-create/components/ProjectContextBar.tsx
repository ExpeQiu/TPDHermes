"use client";

import type { ProjectContextResponse } from "@/lib/chat-context";

export type ProjectContextLoadState = "loading" | "ready" | "error";

type Props = {
  projectName: string;
  context: ProjectContextResponse | null;
  contextLoadState: ProjectContextLoadState;
  outputCount: number;
  embedded?: boolean;
};

const contextStatusLabel: Record<ProjectContextLoadState, string> = {
  loading: "加载中…",
  ready: "已启用",
  error: "不可用",
};

export function ProjectContextBar({
  projectName,
  context,
  contextLoadState,
  outputCount,
  embedded,
}: Props) {
  const resolvedState: ProjectContextLoadState =
    contextLoadState === "ready" && context ? "ready" : contextLoadState;

  const content = (
    <>
      <span className="font-medium text-slate-800 dark:text-slate-200">项目：{projectName}</span>
      <span className="mx-2 text-slate-400">·</span>
      <span
        className={
          resolvedState === "error"
            ? "text-amber-700 dark:text-amber-300"
            : undefined
        }
        title={
          resolvedState === "error"
            ? "项目不存在、已删除，或当前 User ID 无权访问"
            : undefined
        }
      >
        项目上下文：{contextStatusLabel[resolvedState]}
      </span>
      <span className="mx-2 text-slate-400">·</span>
      <span>最近输出：{outputCount}</span>
    </>
  );

  if (embedded) {
    return <span className="inline-flex flex-wrap items-center text-slate-600 dark:text-slate-400">{content}</span>;
  }

  return (
    <div className="shrink-0 border-b border-slate-300 bg-slate-100/80 px-4 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
      {content}
    </div>
  );
}
