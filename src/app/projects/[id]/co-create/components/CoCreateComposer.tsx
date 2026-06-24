"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import type {
  CoCreatePipelinePreference,
  ContentRegionBlock,
} from "@/app/projects/[id]/co-create/co-create-types";
import { decodeProjectFileSelectValue } from "@/lib/chat-context";
import type { ProjectFileItem } from "@/lib/co-create-api";

type Props = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  streaming?: boolean;
  onStop?: () => void;
  hint?: string;
  pipelinePreference: CoCreatePipelinePreference;
  onPipelinePreferenceChange: (value: CoCreatePipelinePreference) => void;
  pinnedFileIds?: string[];
  roundFileIds?: string[];
  files?: ProjectFileItem[];
  onRemoveFileRef?: (fileKey: string, scope: "pinned" | "round") => void;
  regionBlocks?: ContentRegionBlock[];
  onRemoveRegionBlock?: (id: string) => void;
};

function fileLabel(files: ProjectFileItem[], fileKey: string): string {
  const decoded = decodeProjectFileSelectValue(fileKey);
  if (!decoded) return fileKey;
  const file = files.find((f) => f.id === decoded.id && f.kind === decoded.kind);
  return file?.title ?? decoded.id.slice(0, 8);
}

export function CoCreateComposer({
  input,
  onInputChange,
  onSend,
  disabled,
  streaming,
  onStop,
  hint,
  pipelinePreference,
  onPipelinePreferenceChange,
  pinnedFileIds = [],
  roundFileIds = [],
  files = [],
  onRemoveFileRef,
  regionBlocks = [],
  onRemoveRegionBlock,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const refCount = pinnedFileIds.length + roundFileIds.length;
  const canSend =
    !disabled && !streaming && (input.trim().length > 0 || regionBlocks.length > 0);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  useEffect(() => {
    resizeTextarea();
  }, [input]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void onSend();
    }
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-2">
      <div className="rounded-2xl border border-slate-300/90 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-slate-600/80 dark:bg-slate-900/95 dark:shadow-none">
        <div className="px-3 pt-3">
          {refCount > 0 || regionBlocks.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pinnedFileIds.map((key) => (
                <ContextChip
                  key={`p-${key}`}
                  label={fileLabel(files, key)}
                  tone="pinned"
                  onRemove={onRemoveFileRef ? () => onRemoveFileRef(key, "pinned") : undefined}
                />
              ))}
              {roundFileIds.map((key) => (
                <ContextChip
                  key={`r-${key}`}
                  label={fileLabel(files, key)}
                  tone="round"
                  onRemove={onRemoveFileRef ? () => onRemoveFileRef(key, "round") : undefined}
                />
              ))}
              {regionBlocks.map((block) => (
                <RegionBlockChip
                  key={block.id}
                  label={`${block.fileName} (${block.startLine}-${block.endLine})`}
                  onRemove={
                    onRemoveRegionBlock ? () => onRemoveRegionBlock(block.id) : undefined
                  }
                />
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              refCount > 0
                ? "描述你的创作需求… 回车发送，Shift+回车换行"
                : (hint ?? "描述你的创作需求… 支持 /生成新文件 /改写当前文件")
            }
            rows={1}
            disabled={disabled || streaming}
            className="max-h-40 min-h-[1.75rem] w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:opacity-60 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <select
              value={pipelinePreference}
              onChange={(e) => onPipelinePreferenceChange(e.target.value as CoCreatePipelinePreference)}
              disabled={disabled || streaming}
              aria-label="选择共创模式"
              className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 outline-none transition focus:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              <option value="auto">Auto</option>
              <option value="fast">快速</option>
              <option value="co_create">共创</option>
              <option value="rewrite">改写</option>
              <option value="research">研究</option>
            </select>
            {refCount > 0 ? (
              <span className="truncate text-[11px] text-slate-400">
                已引用 {refCount} 个文件
                {regionBlocks.length > 0 ? ` · ${regionBlocks.length} 个选段` : ""}
              </span>
            ) : regionBlocks.length > 0 ? (
              <span className="truncate text-[11px] text-slate-400">
                已引用 {regionBlocks.length} 个选段
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {streaming ? (
              <>
                <span
                  className="inline-flex h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 dark:border-slate-600 dark:border-t-blue-400"
                  aria-hidden
                />
                <button
                  type="button"
                  onClick={onStop}
                  className="inline-flex h-8 items-center rounded-full border border-slate-200 px-2.5 text-[11px] text-slate-600 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  停止
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void onSend()}
                aria-label="发送"
                className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition ${
                  canSend
                    ? "bg-slate-800 text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
                    : "bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-600"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RegionBlockChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove?: () => void;
}) {
  return (
    <span
      className="inline-flex max-w-[14rem] items-center gap-1 rounded-md bg-teal-950/90 px-2 py-0.5 text-[11px] text-teal-300 dark:bg-teal-900/70"
      title={label}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3 w-3 shrink-0 opacity-80"
        fill="currentColor"
        aria-hidden
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 opacity-60 transition hover:opacity-100"
          aria-label={`移除 ${label}`}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function ContextChip({
  label,
  tone,
  onRemove,
}: {
  label: string;
  tone: "pinned" | "round";
  onRemove?: () => void;
}) {
  return (
    <span
      className={`inline-flex max-w-[10rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
        tone === "pinned"
          ? "border-indigo-400/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-200"
          : "border-blue-400/40 bg-blue-500/10 text-blue-700 dark:text-blue-200"
      }`}
    >
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 opacity-60 transition hover:opacity-100"
          aria-label={`移除 ${label}`}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
