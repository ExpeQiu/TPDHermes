"use client";

import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

type Props = {
  proposal: Extract<FileActionProposal, { type: "patch" }>;
  onViewDiff: () => void;
  onApply: () => void;
  onSaveVersion: () => void;
  onSaveCopy: () => void;
  onCancel: () => void;
};

export function FilePatchCard({
  proposal,
  onViewDiff,
  onApply,
  onSaveVersion,
  onSaveCopy,
  onCancel,
}: Props) {
  const applied = proposal.status === "applied";
  const applying = proposal.status === "applying";
  const failed = proposal.status === "failed";
  const rejected = proposal.status === "rejected";

  return (
    <div className="my-3 rounded-xl border border-amber-300 bg-amber-50/80 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
        {applied
          ? "Agent 已修改文件"
          : applying
            ? "Agent 正在修改文件"
            : failed
              ? "自动修改失败"
              : rejected
                ? "已忽略修改"
                : "修改文件提案"}
      </p>
      <p className="mt-1 text-sm font-medium">{proposal.fileName}</p>
      <p className="text-xs text-slate-600 dark:text-slate-400">{proposal.summary}</p>
      {applied ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onViewDiff} className="rounded-lg border px-3 py-1.5 text-xs">
            查看 Diff
          </button>
          <span className="text-xs text-amber-800 dark:text-amber-200">
            已自动修改并保存，可在顶部撤销最近一次 AI 变更。
          </span>
        </div>
      ) : applying ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onViewDiff} className="rounded-lg border px-3 py-1.5 text-xs">
            查看 Diff
          </button>
          <span className="text-xs text-amber-800 dark:text-amber-200">正在把修改写回文件…</span>
        </div>
      ) : rejected ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">该修改提案已忽略。</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onViewDiff} className="rounded-lg border px-3 py-1.5 text-xs">
            查看 Diff
          </button>
          <button
            type="button"
            disabled={applying}
            onClick={onApply}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {failed ? "重试修改" : "应用修改"}
          </button>
          <button type="button" onClick={onSaveVersion} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为新版本
          </button>
          <button type="button" onClick={onSaveCopy} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为副本
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-slate-500">
            忽略
          </button>
        </div>
      )}
    </div>
  );
}
