"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fetchProjectFileDetail, type ProjectFileDetail } from "@/lib/co-create-api";
import { ProjectOutputContentBody } from "@/components/project-output-content";
import { formatDateTimeShanghai } from "@/lib/datetime";

export type AttachmentPreviewItem = {
  id: string;
  original_filename: string;
  content_type?: string | null;
  size_bytes: number;
  created_at?: string | null;
  ingest_status?: string | null;
};

type PreviewKind = "pdf" | "image" | "text" | "binary";

function attachmentPreviewKind(filename: string, contentType?: string | null): PreviewKind {
  const lower = filename.toLowerCase();
  const ct = (contentType || "").toLowerCase();
  if (lower.endsWith(".pdf") || ct.includes("pdf")) return "pdf";
  if (
    /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(lower) ||
    ct.startsWith("image/")
  ) {
    return "image";
  }
  if (
    /\.(txt|md|markdown|csv|json|docx?)$/i.test(lower) ||
    ct.startsWith("text/") ||
    ct.includes("wordprocessingml")
  ) {
    return "text";
  }
  return "binary";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


type Props = {
  open: boolean;
  projectId: string;
  attachment: AttachmentPreviewItem | null;
  onClose: () => void;
};

export function AttachmentPreviewModal({ open, projectId, attachment, onClose }: Props) {
  const [detail, setDetail] = useState<ProjectFileDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobLoading, setBlobLoading] = useState(false);
  const [blobError, setBlobError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const previewKind = useMemo(
    () =>
      attachment
        ? attachmentPreviewKind(attachment.original_filename, attachment.content_type)
        : "binary",
    [attachment],
  );

  const needsBlobPreview = previewKind === "pdf" || previewKind === "image";

  const resetState = useCallback(() => {
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setBlobLoading(false);
    setBlobError(null);
    setDownloading(false);
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open || !attachment || !projectId) {
      resetState();
      return;
    }

    let cancelled = false;
    resetState();
    setDetailLoading(true);

    void fetchProjectFileDetail(projectId, attachment.id, "attachment")
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        console.info("[project] 附件预览内容已加载", {
          project_id: projectId,
          attachment_id: attachment.id,
          file_name: attachment.original_filename,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "加载预览失败";
        setDetailError(message);
        console.warn("[project] 附件预览内容加载失败", {
          project_id: projectId,
          attachment_id: attachment.id,
          err,
        });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    if (needsBlobPreview) {
      setBlobLoading(true);
      void apiFetch(`/projects/${projectId}/attachments/${attachment.id}/download`)
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
          }
          return res.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          setBlobUrl(url);
        })
        .catch((err) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : "加载原文件失败";
          setBlobError(message);
          console.warn("[project] 附件原文件加载失败", {
            project_id: projectId,
            attachment_id: attachment.id,
            err,
          });
        })
        .finally(() => {
          if (!cancelled) setBlobLoading(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [attachment, needsBlobPreview, open, projectId, resetState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleDownload = async () => {
    if (!attachment || !projectId) return;
    setDownloading(true);
    try {
      const res = await apiFetch(`/projects/${projectId}/attachments/${attachment.id}/download`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.original_filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[project] 附件下载失败", {
        project_id: projectId,
        attachment_id: attachment.id,
        err,
      });
    } finally {
      setDownloading(false);
    }
  };

  if (!open || !attachment) return null;

  const loading = detailLoading || (needsBlobPreview && blobLoading);
  const showTextFallback =
    previewKind === "text" ||
    previewKind === "binary" ||
    (previewKind === "pdf" && blobError && !blobUrl);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-300 bg-slate-200 shadow-xl dark:border-slate-700 dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-300 px-4 py-3 dark:border-slate-700 sm:px-5">
          <div className="min-w-0">
            <h2
              id="attachment-preview-title"
              className="truncate text-lg font-semibold text-slate-900 dark:text-white"
              title={attachment.original_filename}
            >
              {attachment.original_filename}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {formatFileSize(attachment.size_bytes)} · {formatDateTimeShanghai(attachment.created_at)}
              {attachment.ingest_status ? ` · 入库 ${attachment.ingest_status}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg px-2 py-1 text-slate-400 transition hover:bg-slate-300 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
            aria-label="关闭预览"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-white p-4 dark:bg-slate-900/95 sm:p-5">
          {loading ? <p className="text-sm text-slate-500">加载预览…</p> : null}

          {!loading && previewKind === "pdf" && blobUrl ? (
            <iframe
              title={attachment.original_filename}
              src={blobUrl}
              className="h-[min(70vh,720px)] w-full rounded-xl border border-slate-200 dark:border-slate-700"
            />
          ) : null}

          {!loading && previewKind === "image" && blobUrl ? (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={blobUrl}
                alt={attachment.original_filename}
                className="max-h-[min(70vh,720px)] max-w-full rounded-xl object-contain"
              />
            </div>
          ) : null}

          {!loading && blobError && needsBlobPreview ? (
            <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">
              原文件预览不可用，已尝试展示提取文本：{blobError}
            </p>
          ) : null}

          {!loading && detailError ? (
            <p className="text-sm text-red-500">{detailError}</p>
          ) : null}

          {!loading && showTextFallback && detail ? (
            <div className="text-sm leading-relaxed text-slate-800 dark:text-slate-200">
              <ProjectOutputContentBody
                content={detail.content}
                contentFormat={detail.content_format}
                loading={false}
              />
            </div>
          ) : null}

          {!loading && !detailError && !detail && !blobUrl ? (
            <p className="text-sm text-slate-500">暂无预览内容</p>
          ) : null}
        </div>

        <div className="flex gap-3 border-t border-slate-300 px-4 py-3 dark:border-slate-700 sm:px-5">
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading}
            className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-800 transition hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
          >
            {downloading ? "下载中…" : "下载原文件"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
