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

export type BoundProjectOption = {
  id: string;
  name: string;
  status?: string;
};

/** 当前项目始终在列表里；其余只保留进行中的项目。 */
export function buildBoundProjectOptions(
  routeProjectId: string,
  projects: BoundProjectOption[],
  listAll = false,
): BoundProjectOption[] {
  const byId = new Map<string, BoundProjectOption>();
  for (const project of projects) {
    if (!project.id) continue;
    if (listAll || project.id === routeProjectId || project.status === "active") {
      byId.set(project.id, project);
    }
  }
  if (routeProjectId && !byId.has(routeProjectId)) {
    byId.set(routeProjectId, { id: routeProjectId, name: "当前项目", status: "active" });
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.id === routeProjectId) return -1;
    if (b.id === routeProjectId) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
}

type Props = {
  projectId: string;
  boundProjectId?: string;
  routeProjectId?: string;
  projects?: BoundProjectOption[];
  /** 对话页可清空绑定；项目共创房间始终绑定当前项目 */
  allowUnbound?: boolean;
  /** 列出传入的全部项目，而不是只保留进行中 */
  listAllProjects?: boolean;
  onBoundProjectChange?: (projectId: string) => void;
  files: ProjectFileItem[];
  loading: boolean;
  openTabKeys: string[];
  activeFileKey: string | null;
  pinnedFileIds: string[];
  roundFileIds: string[];
  onSelectPreview: (fileKey: string | null) => void;
  onRefresh: () => void;
  pinLabel?: string;
  onTogglePin?: () => void;
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
  boundProjectId,
  routeProjectId,
  projects = [],
  allowUnbound = false,
  listAllProjects = false,
  onBoundProjectChange,
  files,
  loading,
  openTabKeys,
  activeFileKey,
  pinnedFileIds,
  roundFileIds,
  onSelectPreview,
  onRefresh,
  pinLabel,
  onTogglePin,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [exportingKey, setExportingKey] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const explicitRouteId = routeProjectId?.trim() ?? "";
  const routeId = explicitRouteId || projectId;
  const boundId = boundProjectId || projectId;
  const projectOptions = useMemo(() => {
    const options = buildBoundProjectOptions(routeId, projects, listAllProjects);
    if (boundId && !options.some((item) => item.id === boundId)) {
      options.push({ id: boundId, name: "已选项目", status: "active" });
    }
    return options;
  }, [boundId, listAllProjects, projects, routeId]);

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
    <aside className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden border-l border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="shrink-0 space-y-2 border-b border-slate-300 p-3 dark:border-slate-700">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">项目文件</p>
          {onTogglePin ? (
            <button
              type="button"
              onClick={onTogglePin}
              className="shrink-0 text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            >
              {pinLabel}
            </button>
          ) : null}
        </div>
        <label className="block space-y-1">
          <span className="text-[10px] text-slate-500">绑定项目</span>
          <select
            aria-label="绑定项目"
            value={boundId}
            disabled={!onBoundProjectChange || (projectOptions.length === 0 && !allowUnbound)}
            onChange={(e) => {
              const next = e.target.value;
              if (next === boundId) return;
              if (!next && !allowUnbound) return;
              console.info("[co-create] 文件栏切换绑定项目", { from: boundId, to: next || null });
              onBoundProjectChange?.(next);
            }}
            className="w-full truncate rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {allowUnbound ? <option value="">不绑定项目</option> : null}
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name || project.id}
                {explicitRouteId && project.id === explicitRouteId ? "（当前）" : ""}
              </option>
            ))}
          </select>
        </label>
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
        ) : !projectId ? (
          <p className="p-4 text-xs leading-relaxed text-slate-500">先绑定项目，再选择要关联的文件。</p>
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
                className={`group flex w-full items-stretch gap-1 rounded-md text-[11px] transition ${
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
                  className="flex min-w-0 flex-1 items-start gap-1.5 rounded-md px-1.5 py-1 text-left no-underline"
                >
                  <span className="relative shrink-0 text-[11px] leading-none">
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
          className="w-full rounded-lg border border-blue-300 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-800 transition hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
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
