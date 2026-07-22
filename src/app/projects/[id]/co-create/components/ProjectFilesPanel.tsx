"use client";

import { useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import {
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  type ProjectFileKind,
} from "@/lib/chat-context";
import { exportProjectFileToLocal, uploadProjectAttachment } from "@/lib/co-create-api";
import type { ProjectFileItem } from "@/lib/co-create-api";
import type { FileRefState } from "@/app/projects/[id]/co-create/co-create-types";

type FilterKind = "all" | "output" | "attachment";

type Props = {
  projectId: string;
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
  projectId,
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePickAttachment = () => {
    setUploadError(null);
    fileInputRef.current?.click();
  };

  const handleAttachmentFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !projectId) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadProjectAttachment(projectId, file);
      onRefresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "上传失败");
      console.warn("[co-create] 附件上传失败", { projectId, err });
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async (e: MouseEvent, file: ProjectFileItem) => {
    e.stopPropagation();
    e.preventDefault();
    if (!projectId) return;
    const fileKey = encodeProjectFileSelectValue(file.kind, file.id);
    setExportingKey(fileKey);
    setExportError(null);
    try {
      const result = await exportProjectFileToLocal(projectId, file);
      console.info("[co-create] 已触发本地下载", { projectId, fileKey, filename: result.filename });
    } catch (err) {
      const message = err instanceof Error ? err.message : "导出失败";
      setExportError(message);
      console.warn("[co-create] 导出失败", { projectId, fileKey, err });
    } finally {
      setExportingKey(null);
    }
  };

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
        {exportError ? (
          <p className="text-[10px] leading-relaxed text-red-500">{exportError}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1">
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
            const isExporting = exportingKey === fileKey;
            return (
              <div
                key={fileKey}
                className={`group flex w-full items-stretch gap-1 rounded-md text-xs transition ${
                  isActive
                    ? "bg-blue-50 dark:bg-blue-950/30"
                    : isOpen
                      ? "bg-slate-200/70 dark:bg-slate-800/50"
                      : "hover:bg-slate-200/60 dark:hover:bg-slate-800/60"
                }`}
              >
                <button
                  type="button"
                  data-file-key={fileKey}
                  aria-current={isActive ? "true" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    e.currentTarget.focus({ preventScroll: true });
                    console.info("[co-create] 点击文件列表项", {
                      fileKey,
                      title: file.title,
                      kind: file.kind,
                    });
                    onSelectPreview(fileKey);
                  }}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left no-underline"
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
                <button
                  type="button"
                  title={`导出 ${file.title}`}
                  aria-label={`导出 ${file.title}`}
                  disabled={isExporting || !projectId}
                  onClick={(e) => void handleExport(e, file)}
                  className="my-1 mr-1 shrink-0 self-center rounded-md px-1.5 py-1 text-[10px] font-medium text-slate-600 opacity-80 transition hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-blue-300"
                >
                  {isExporting ? "…" : "导出"}
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-slate-300 p-3 dark:border-slate-700">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => void handleAttachmentFileChange(e)}
        />
        <button
          type="button"
          onClick={handlePickAttachment}
          disabled={uploading || !projectId}
          className="w-full rounded-xl border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800 transition hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
        >
          {uploading ? "上传中…" : "上传附件"}
        </button>
        {uploadError ? (
          <p className="mt-2 text-[10px] leading-relaxed text-red-500">{uploadError}</p>
        ) : null}
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
