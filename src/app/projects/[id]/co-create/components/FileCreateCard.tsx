"use client";

import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";
import { isAutoCreateFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-draft";

type Props = {
  proposal: Extract<FileActionProposal, { type: "create" }>;
  onCreateNew: () => void;
  onUpdateTo: () => void;
  onCancel: () => void;
  updateToDisabled?: boolean;
};

export function FileCreateCard({
  proposal,
  onCreateNew,
  onUpdateTo,
  onCancel,
  updateToDisabled,
}: Props) {
  const applied = proposal.status === "applied";
  const applying = proposal.status === "applying";
  const failed = proposal.status === "failed";
  const rejected = proposal.status === "rejected";
  const autoSynced = isAutoCreateFallbackProposal(proposal.proposalId);
  const compact = autoSynced && (applied || applying);

  if (compact) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-emerald-300/80 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
        <span className="font-medium">{applying ? "正在同步文稿" : "已同步文稿"}</span>
        <span className="truncate text-emerald-700/90 dark:text-emerald-300/90">{proposal.fileName}</span>
      </div>
    );
  }

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
      {applied ? (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-200">
          已保存至输出物，可在顶部撤销最近一次 AI 变更。
        </p>
      ) : applying ? (
        <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-200">
          正在写入项目输出物…
        </p>
      ) : rejected ? (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">该创建提案已忽略。</p>
      ) : failed && proposal.applyError ? (
        <p className="mt-3 text-xs text-rose-700 dark:text-rose-300">失败原因：{proposal.applyError}</p>
      ) : null}
      {!applied && !applying && !rejected ? (
        <>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            「创建新文件」保存至右侧输出物；「更新到」覆盖已有输出物文件。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={applying}
              onClick={onCreateNew}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {failed ? "重试创建新文件" : "创建新文件"}
            </button>
            <button
              type="button"
              disabled={applying || updateToDisabled}
              onClick={onUpdateTo}
              className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              更新到
            </button>
            <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-slate-500">
              取消
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
