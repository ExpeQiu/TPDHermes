"use client";

import type { ProjectFileItem } from "@/lib/co-create-api";

type Props = {
  open: boolean;
  fileName: string;
  outputs: ProjectFileItem[];
  onSelect: (file: ProjectFileItem) => void;
  onClose: () => void;
};

export function UpdateToOutputDialog({ open, fileName, outputs, onSelect, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-labelledby="update-to-output-title"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p id="update-to-output-title" className="text-sm font-semibold text-slate-900 dark:text-white">
          更新到输出物
        </p>
        <p className="mt-1 text-xs text-slate-500">
          选择要覆盖的文件，将「{fileName}」的内容写入并覆盖原稿。
        </p>
        <div className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700">
          {outputs.length === 0 ? (
            <p className="p-4 text-xs leading-relaxed text-slate-500">
              暂无输出物。请使用「创建新文件」，或先在右侧文件栏切换到「输出物」查看。
            </p>
          ) : (
            outputs.map((file) => (
              <button
                key={file.id}
                type="button"
                onClick={() => onSelect(file)}
                className="flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-xs transition last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
              >
                <span className="shrink-0">📄</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 dark:text-white">
                    {file.title}
                  </span>
                  <span className="block truncate text-[10px] text-slate-500">{file.path}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
