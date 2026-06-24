"use client";

import type { ProjectContextResponse } from "@/lib/chat-context";

type Props = {
  projectName: string;
  context: ProjectContextResponse | null;
  outputCount: number;
  embedded?: boolean;
};

export function ProjectContextBar({ projectName, context, outputCount, embedded }: Props) {
  const content = (
    <>
      <span className="font-medium text-slate-800 dark:text-slate-200">项目：{projectName}</span>
      <span className="mx-2 text-slate-400">·</span>
      <span>项目上下文：{context ? "已启用" : "加载中…"}</span>
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
