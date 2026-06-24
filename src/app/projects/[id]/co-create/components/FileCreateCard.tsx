"use client";

import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

type Props = {
  proposal: Extract<FileActionProposal, { type: "create" }>;
  onCreate: () => void;
  onEdit: () => void;
  onCancel: () => void;
};

export function FileCreateCard({ proposal, onCreate, onEdit, onCancel }: Props) {
  const applied = proposal.status === "applied";
  const applying = proposal.status === "applying";
  const failed = proposal.status === "failed";
  const rejected = proposal.status === "rejected";

  return (
    <div className="my-3 rounded-xl border border-emerald-300 bg-emerald-50/80 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
      <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">
        {applied
          ? "Agent 已创建文件"
          : applying
            ? "Agent 正在创建文件"
            : failed
              ? "自动创建失败"
              : rejected
                ? "已忽略创建"
                : "创建文件提案"}
      </p>
      <p className="mt-1 text-sm font-medium">{proposal.fileName}</p>
      <p className="text-xs text-slate-500">路径：{proposal.path}</p>
      <pre className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-white/80 p-2 text-xs dark:bg-slate-900/60">
        {proposal.content.slice(0, 1200)}
        {proposal.content.length > 1200 ? "…" : ""}
      </pre>
      {applied ? (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-200">
          已自动创建并保存，可在顶部撤销最近一次 AI 变更。
        </p>
      ) : applying ? (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-200">
          正在把生成结果写入项目文件区…
        </p>
      ) : rejected ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">该创建提案已忽略。</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={applying}
            onClick={onCreate}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {failed ? "重试创建" : "创建文件"}
          </button>
          <button type="button" onClick={onEdit} className="rounded-lg border px-3 py-1.5 text-xs">
            编辑后创建
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-slate-500">
            取消
          </button>
        </div>
      )}
    </div>
  );
}
