"use client";

import {
  decodeProjectFileSelectValue,
  type ProjectFileKind,
} from "@/lib/chat-context";
import type { ProjectFileItem } from "@/lib/co-create-api";

type Props = {
  pinnedFileIds: string[];
  roundFileIds: string[];
  files: ProjectFileItem[];
  onRemove: (fileKey: string, scope: "pinned" | "round") => void;
  onManage?: () => void;
  embedded?: boolean;
};

function fileLabel(files: ProjectFileItem[], fileKey: string): string {
  const decoded = decodeProjectFileSelectValue(fileKey);
  if (!decoded) return fileKey;
  const file = files.find((f) => f.id === decoded.id && f.kind === decoded.kind);
  return file?.title ?? decoded.id.slice(0, 8);
}

export function FileReferenceBar({
  pinnedFileIds,
  roundFileIds,
  files,
  onRemove,
  embedded,
}: Props) {
  if (pinnedFileIds.length === 0 && roundFileIds.length === 0) {
    const empty = (
      <span className="text-slate-500">
        尚未引用文件 — 在右侧文件区选择后「加入本轮」或「固定引用」
      </span>
    );
    if (embedded) return empty;
    return (
      <div className="shrink-0 border-b border-dashed border-slate-300 px-4 py-2 text-xs text-slate-500 dark:border-slate-700">
        {empty}
      </div>
    );
  }

  const content = (
    <>
      {pinnedFileIds.length > 0 ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-slate-500">固定引用：</span>
          {pinnedFileIds.map((key) => (
            <FileChip key={`p-${key}`} label={fileLabel(files, key)} onRemove={() => onRemove(key, "pinned")} tone="pinned" />
          ))}
        </span>
      ) : null}
      {pinnedFileIds.length > 0 && roundFileIds.length > 0 ? (
        <span className="mx-2 text-slate-400">·</span>
      ) : null}
      {roundFileIds.length > 0 ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-slate-500">本轮引用：</span>
          {roundFileIds.map((key) => (
            <FileChip key={`r-${key}`} label={fileLabel(files, key)} onRemove={() => onRemove(key, "round")} tone="round" />
          ))}
        </span>
      ) : null}
    </>
  );

  if (embedded) {
    return <span className="inline-flex flex-wrap items-center">{content}</span>;
  }

  return (
    <div className="shrink-0 space-y-1 border-b border-slate-300 bg-white/50 px-4 py-2 dark:border-slate-700 dark:bg-slate-900/30">
      {pinnedFileIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">固定引用：</span>
          {pinnedFileIds.map((key) => (
            <FileChip key={`p-${key}`} label={fileLabel(files, key)} onRemove={() => onRemove(key, "pinned")} tone="pinned" />
          ))}
        </div>
      ) : null}
      {roundFileIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">本轮引用：</span>
          {roundFileIds.map((key) => (
            <FileChip key={`r-${key}`} label={fileLabel(files, key)} onRemove={() => onRemove(key, "round")} tone="round" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileChip({
  label,
  onRemove,
  tone,
}: {
  label: string;
  onRemove: () => void;
  tone: "pinned" | "round";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
        tone === "pinned"
          ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200"
          : "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200"
      }`}
    >
      {label}
      <button type="button" onClick={onRemove} className="opacity-70 hover:opacity-100">
        ×
      </button>
    </span>
  );
}

export function encodeFileKey(kind: ProjectFileKind, id: string): string {
  return `${kind}:${id}`;
}
