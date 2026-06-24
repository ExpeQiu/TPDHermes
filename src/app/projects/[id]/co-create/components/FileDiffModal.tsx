"use client";

import { InlineTextDiff } from "@/app/projects/[id]/co-create/components/InlineTextDiff";

type Props = {
  open: boolean;
  fileName: string;
  before: string;
  after: string;
  onApply: () => void;
  onSaveVersion: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
};

export function FileDiffModal({
  open,
  fileName,
  before,
  after,
  onApply,
  onSaveVersion,
  onSaveCopy,
  onClose,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h3 className="text-sm font-semibold">修改预览：{fileName}</h3>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <InlineTextDiff before={before} after={after} showLegend />
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
          <button type="button" onClick={onApply} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white">
            应用修改
          </button>
          <button type="button" onClick={onSaveVersion} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为新版本
          </button>
          <button type="button" onClick={onSaveCopy} className="rounded-lg border px-3 py-1.5 text-xs">
            另存为副本
          </button>
          <button type="button" onClick={onClose} className="ml-auto rounded-lg px-3 py-1.5 text-xs text-slate-500">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
