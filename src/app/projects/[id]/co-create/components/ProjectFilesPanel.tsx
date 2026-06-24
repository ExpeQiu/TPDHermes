"use client";

import { useMemo, useState } from "react";
import {
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  type ProjectFileKind,
} from "@/lib/chat-context";
import type { ProjectFileItem } from "@/lib/co-create-api";
import type { FileRefState } from "@/app/projects/[id]/co-create/co-create-types";

type FilterKind = "all" | "output" | "attachment";

type Props = {
  files: ProjectFileItem[];
  loading: boolean;
  openTabKeys: string[];
  activeFileKey: string | null;
  pinnedFileIds: string[];
  roundFileIds: string[];
  onSelectPreview: (fileKey: string | null) => void;
  onRefresh: () => void;
};

function refStateFor(fileKey: string, pinned: string[], round: string[]): FileRefState {
  if (pinned.includes(fileKey)) return "pinned";
  if (round.includes(fileKey)) return "round";
  return "unselected";
}

const refBadge: Record<FileRefState, string> = {
  unselected: "",
  round: "本轮",
  pinned: "固定",
  ai_suggested: "推荐",
};

export function ProjectFilesPanel({
  files,
  loading,
  openTabKeys,
  activeFileKey,
  pinnedFileIds,
  roundFileIds,
  onSelectPreview,
  onRefresh,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");

  const filtered = useMemo(() => {
    let list = files;
    if (filter === "output") list = list.filter((f) => f.kind === "output");
    if (filter === "attachment") list = list.filter((f) => f.kind === "attachment");
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (f) =>
          f.title.toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q) ||
          (f.summary ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [files, filter, search]);

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="shrink-0 space-y-2 border-b border-slate-300 p-3 dark:border-slate-700">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">项目文件</p>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索文件…"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs dark:border-slate-600 dark:bg-slate-800"
        />
        <div className="flex flex-wrap gap-1">
          {(["all", "output", "attachment"] as FilterKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded-md px-2 py-0.5 text-[10px] ${
                filter === k
                  ? "bg-blue-600 text-white"
                  : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
              }`}
            >
              {k === "all" ? "全部" : k === "output" ? "输出物" : "附件"}
            </button>
          ))}
          <button
            type="button"
            onClick={onRefresh}
            className="ml-auto rounded-md px-2 py-0.5 text-[10px] text-slate-500 hover:text-slate-800"
          >
            刷新
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <p className="p-4 text-xs text-slate-500">加载文件…</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-xs leading-relaxed text-slate-500">
            暂无项目文件。可上传参考资料，或让 Agent 生成初始文件。
          </p>
        ) : (
          filtered.map((file) => {
            const fileKey = encodeProjectFileSelectValue(file.kind, file.id);
            const state = refStateFor(fileKey, pinnedFileIds, roundFileIds);
            const isOpen = openTabKeys.includes(fileKey);
            const isActive = activeFileKey === fileKey;
            return (
              <button
                key={fileKey}
                type="button"
                onClick={(e) => {
                  e.currentTarget.focus({ preventScroll: true });
                  onSelectPreview(fileKey);
                }}
                className={`flex w-full items-start gap-2 border-b border-slate-200 px-3 py-2 text-left text-xs transition dark:border-slate-800 ${
                  isActive
                    ? "bg-blue-50 dark:bg-blue-950/30"
                    : isOpen
                      ? "bg-slate-200/70 dark:bg-slate-800/50"
                      : "hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
                }`}
              >
                <span className="relative shrink-0 text-sm leading-none">
                  {file.kind === "output" ? "📄" : "📎"}
                  {isOpen ? (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-blue-500 ring-1 ring-white dark:ring-slate-900"
                      title="已打开"
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{file.title}</span>
                  <span className="block truncate text-[10px] text-slate-500">{file.path}</span>
                </span>
                {state !== "unselected" ? (
                  <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] dark:bg-slate-700">
                    {refBadge[state]}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}

export function fileKeyFromParams(
  outputId?: string | null,
  fileId?: string | null,
  kind?: ProjectFileKind | null,
): string | null {
  if (outputId) return encodeProjectFileSelectValue("output", outputId);
  if (fileId && kind) return encodeProjectFileSelectValue(kind, fileId);
  if (fileId) {
    const decoded = decodeProjectFileSelectValue(fileId);
    if (decoded) return fileId;
    return encodeProjectFileSelectValue("output", fileId);
  }
  return null;
}
