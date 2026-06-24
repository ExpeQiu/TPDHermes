"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  CoCreateAgentMode,
  CoCreateApplyMode,
  ContentRegionBlock,
} from "@/app/projects/[id]/co-create/co-create-types";
import { coCreateAgentModeMeta } from "@/app/projects/[id]/co-create/co-create-agent-utils";
import { decodeProjectFileSelectValue, encodeProjectFileSelectValue } from "@/lib/chat-context";
import type { ProjectFileItem } from "@/lib/co-create-api";

const AGENT_MODES: CoCreateAgentMode[] = ["ask", "agent", "plan"];

type Props = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  streaming?: boolean;
  onStop?: () => void;
  hint?: string;
  agentMode: CoCreateAgentMode;
  onAgentModeChange: (value: CoCreateAgentMode) => void;
  applyMode: CoCreateApplyMode;
  onApplyModeChange: (value: CoCreateApplyMode) => void;
  pinnedFileIds?: string[];
  roundFileIds?: string[];
  files?: ProjectFileItem[];
  onRemoveFileRef?: (fileKey: string, scope: "pinned" | "round") => void;
  regionBlocks?: ContentRegionBlock[];
  onRemoveRegionBlock?: (id: string) => void;
  onMentionFile?: (fileKey: string) => void;
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
  agentMode,
  onAgentModeChange,
  applyMode,
  onApplyModeChange,
  pinnedFileIds = [],
  roundFileIds = [],
  files = [],
  onRemoveFileRef,
  regionBlocks = [],
  onRemoveRegionBlock,
  onMentionFile,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionIndex, setMentionIndex] = useState(0);
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

  const mentionCandidates = useMemo(() => {
    if (!mentionOpen || !onMentionFile) return [];
    const q = mentionQuery.trim().toLowerCase();
    return files
      .filter((file) => {
        const label = fileLabel(files, encodeProjectFileSelectValue(file.kind, file.id));
        return !q || label.toLowerCase().includes(q) || file.title.toLowerCase().includes(q);
      })
      .slice(0, 8);
  }, [files, mentionOpen, mentionQuery, onMentionFile]);

  const syncMentionFromInput = (value: string, cursor: number) => {
    if (!onMentionFile || files.length === 0) {
      setMentionOpen(false);
      return;
    }
    const before = value.slice(0, cursor);
    const atMatch = before.match(/@([^\s@]*)$/);
    if (!atMatch) {
      setMentionOpen(false);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(atMatch[1] ?? "");
    setMentionStart(cursor - (atMatch[0]?.length ?? 0));
    setMentionIndex(0);
  };

  const handleInputChange = (value: string) => {
    onInputChange(value);
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    syncMentionFromInput(value, cursor);
  };

  const selectMention = (file: ProjectFileItem) => {
    const key = encodeProjectFileSelectValue(file.kind, file.id);
    onMentionFile?.(key);
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, mentionStart);
    const after = input.slice(cursor);
    const next = `${before}${after}`.replace(/\s{2,}/g, " ");
    onInputChange(next);
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = mentionCandidates[mentionIndex];
        if (picked) selectMention(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void onSend();
    }
  };

  const showApplyToggle = agentMode !== "ask";

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

          <div className="relative">
            {mentionOpen && mentionCandidates.length > 0 ? (
              <div className="absolute bottom-full left-0 z-20 mb-1 max-h-48 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                {mentionCandidates.map((file, index) => {
                  const key = encodeProjectFileSelectValue(file.kind, file.id);
                  const label = fileLabel(files, key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectMention(file)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                        index === mentionIndex
                          ? "bg-blue-50 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
                          : "text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
                      }`}
                    >
                      <span className="truncate font-medium">{label}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">{file.kind}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onClick={(e) =>
                syncMentionFromInput(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart ?? e.currentTarget.value.length,
                )
              }
              placeholder={
                refCount > 0
                  ? "描述你的创作需求… 输入 @ 引用文件，回车发送"
                  : (hint ?? "描述你的创作需求… 支持 /生成新文件 /改写当前文件，输入 @ 引用文件")
              }
            rows={1}
            disabled={disabled || streaming}
            className="max-h-40 min-h-[1.75rem] w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 disabled:opacity-60 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <div
              className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/80"
              role="group"
              aria-label="创作模式"
            >
              {AGENT_MODES.map((mode) => {
                const meta = coCreateAgentModeMeta(mode);
                const active = agentMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled || streaming}
                    onClick={() => onAgentModeChange(mode)}
                    title={meta.description}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50 ${
                      active
                        ? meta.badgeClassName + " border"
                        : "border border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>

            {showApplyToggle ? (
              <button
                type="button"
                disabled={disabled || streaming}
                onClick={() => onApplyModeChange(applyMode === "auto" ? "review" : "auto")}
                title={
                  applyMode === "review"
                    ? "文件变更需人工确认后写回"
                    : "文件变更自动写回项目"
                }
                className={`rounded-md border px-2 py-0.5 text-[11px] transition disabled:opacity-50 ${
                  applyMode === "review"
                    ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
                    : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
                }`}
              >
                {applyMode === "review" ? "审阅" : "自动应用"}
              </button>
            ) : null}

            {refCount > 0 ? (
              <span className="truncate text-[11px] text-slate-400">
                {refCount} 文件
                {regionBlocks.length > 0 ? ` · ${regionBlocks.length} 选段` : ""}
              </span>
            ) : regionBlocks.length > 0 ? (
              <span className="truncate text-[11px] text-slate-400">
                {regionBlocks.length} 选段
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
