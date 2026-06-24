"use client";

import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";
import { isAutoPatchFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-patch";
import { patchEditModeLabel } from "@/app/projects/[id]/co-create/co-create-partial-patch";

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
  const autoSynced = isAutoPatchFallbackProposal(proposal.proposalId);
  const compact = autoSynced && (applied || applying);

  if (compact) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-amber-300/80 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <span className="font-medium">{applying ? "正在同步改写" : "已同步改写"}</span>
        <span className="truncate text-amber-700/90 dark:text-amber-300/90">{proposal.fileName}</span>
      </div>
    );
  }

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
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {proposal.editMode && proposal.editMode !== "full" ? (
          <span className="rounded-md border border-amber-400/50 bg-amber-100/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/40 dark:text-amber-100">
            {patchEditModeLabel(proposal.editMode)}
          </span>
        ) : null}
        <p className="text-xs text-slate-600 dark:text-slate-400">{proposal.summary}</p>
      </div>
      {applied ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onViewDiff} className="rounded-lg border px-3 py-1.5 text-xs">
            查看 Diff
          </button>
          <span className="text-xs text-amber-800 dark:text-amber-200">
            已覆盖原稿并记录版本历史，可在预览区「版本」查看；顶部可撤销最近一次 AI 变更。
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
      ) : failed && proposal.applyError ? (
        <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">失败原因：{proposal.applyError}</p>
      ) : null}
      {!applied && !applying && !rejected ? (
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
            {failed ? "重试覆盖" : "覆盖保存"}
          </button>
          <button type="button" onClick={onSaveVersion} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为独立文件
          </button>
          <button type="button" onClick={onSaveCopy} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为副本
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-slate-500">
            忽略
          </button>
        </div>
      ) : null}
    </div>
  );
}
