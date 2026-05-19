"use client";

import { useCallback, useMemo, useRef, type RefObject } from "react";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  isLikelyPdfBinary,
  thumbnailPreviewText,
  triggerWorkshopOutputDownload,
  workshopOutputFormatLabel,
  type WorkshopOutputFormat,
} from "@/lib/workshop-output-artifact";

type GenStatus = "idle" | "generating" | "done" | "error";

function FormatIcon({ format, className = "h-10 w-10" }: { format: WorkshopOutputFormat; className?: string }) {
  const base = `${className} text-slate-300`;
  if (format === "pdf") {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (format === "html") {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="m4 7 8-4 8 4-8 4-8-4Z" />
        <path d="m4 17 8 4 8-4" />
      </svg>
    );
  }
  if (format === "json") {
    return (
      <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    );
  }
  return (
    <svg className={base} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h2M8 17h6M8 9h8" />
    </svg>
  );
}

function ThumbnailBody({
  format,
  content,
  emptyHint,
}: {
  format: WorkshopOutputFormat;
  content: string;
  emptyHint: string;
}) {
  if (!content.trim()) {
    return <p className="px-6 text-center text-sm text-slate-500">{emptyHint}</p>;
  }

  if (format === "pdf" && isLikelyPdfBinary(content)) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-4 text-center">
        <FormatIcon format="pdf" className="h-14 w-14 text-red-300/90" />
        <p className="text-sm font-medium text-slate-200">PDF 产出物</p>
        <p className="text-xs text-slate-500">点击缩略图在下方查看；使用下载保存文件</p>
      </div>
    );
  }

  if (format === "pdf") {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-4 text-center">
        <FormatIcon format="pdf" className="h-12 w-12 text-amber-200/90" />
        <p className="line-clamp-4 max-w-full text-left text-xs leading-relaxed text-slate-400">
          {thumbnailPreviewText(content, 400)}
        </p>
      </div>
    );
  }

  if (format === "markdown" && content.trim()) {
    return (
      <div
        className="origin-top border border-slate-600/60 bg-slate-900/95 px-4 py-3 shadow-md"
        style={{ transform: "scale(0.24)", width: "min(42rem, 120%)" }}
      >
        <div className="max-h-[32rem] overflow-hidden text-left">
          <ChatMarkdownBody content={content.length > 6000 ? `${content.slice(0, 6000)}\n\n…` : content} />
        </div>
      </div>
    );
  }

  if (format === "json") {
    let pretty = content;
    try {
      pretty = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // keep raw
    }
    return (
      <pre className="max-h-full w-full overflow-hidden px-4 py-3 text-left font-mono text-[10px] leading-relaxed text-slate-300">
        {pretty.length > 2000 ? `${pretty.slice(0, 2000)}…` : pretty}
      </pre>
    );
  }

  return (
    <pre className="max-h-full w-full overflow-hidden px-4 py-3 text-left font-mono text-[10px] leading-relaxed text-slate-300">
      {thumbnailPreviewText(content, 2000)}
    </pre>
  );
}

export function WorkshopOutputPanel({
  content,
  format,
  genStatus,
  errorMsg,
  downloadTitle,
  outputEndRef,
}: {
  content: string;
  format: WorkshopOutputFormat;
  genStatus: GenStatus;
  errorMsg: string;
  downloadTitle?: string;
  outputEndRef?: RefObject<HTMLDivElement | null>;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const hasContent = Boolean(content.trim());
  const formatLabel = workshopOutputFormatLabel(format);

  const scrollToDetail = useCallback(() => {
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const emptyThumbHint = useMemo(() => {
    if (errorMsg) return errorMsg;
    if (genStatus === "generating") return "执行中，等待产出…";
    return "尚未执行。开始生成后将显示 Markdown / PDF 等产出物缩略图。";
  }, [errorMsg, genStatus]);

  const onDownload = useCallback(() => {
    if (!hasContent) return;
    triggerWorkshopOutputDownload(content, format, downloadTitle);
  }, [content, format, downloadTitle, hasContent]);

  return (
  <>
      <div className="mb-3 rounded-2xl border border-slate-700/90 bg-slate-900/70 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">产出物缩略</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {formatLabel} · 点击缩略图查看下方详情
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-slate-600 bg-slate-950/80 px-2.5 py-0.5 text-[10px] text-slate-400">
              {formatLabel}
            </span>
            <button
              type="button"
              onClick={onDownload}
              disabled={!hasContent}
              title={`下载 ${formatLabel} 文件`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800/80 px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              下载
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={hasContent ? scrollToDetail : undefined}
          disabled={!hasContent}
          className={`relative mt-2 flex h-44 w-full items-start justify-center overflow-hidden rounded-xl border bg-gradient-to-b from-slate-900 to-slate-950 shadow-inner transition ${
            hasContent
              ? "cursor-pointer border-slate-600/80 hover:border-blue-500/50 hover:ring-1 hover:ring-blue-500/30"
              : "cursor-default border-slate-600/50"
          }`}
          aria-label={hasContent ? "查看产出物详情" : undefined}
        >
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-12 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent"
            aria-hidden
          />
          {!hasContent ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8">
              <FormatIcon format={format} className="h-10 w-10 opacity-40" />
              <p className="max-w-xs text-center text-sm text-slate-500">{emptyThumbHint}</p>
            </div>
          ) : (
            <ThumbnailBody format={format} content={content} emptyHint={emptyThumbHint} />
          )}
          {hasContent ? (
            <span className="pointer-events-none absolute bottom-2 right-2 z-[2] rounded-md bg-slate-950/90 px-2 py-0.5 text-[10px] text-blue-300/90">
              点击查看详情 ↓
            </span>
          ) : null}
        </button>
      </div>

      <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">内容详情</p>
      <div
        ref={detailRef}
        className="min-h-48 max-h-[min(32rem,calc(100vh-12rem))] scroll-mt-4 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/60 p-5 xl:min-h-72"
      >
        {genStatus === "idle" && !hasContent && (
          <p className="text-sm text-slate-500">点击「开始生成」后在此查看完整产出；或点击上方缩略图定位到此处。</p>
        )}
        {genStatus === "generating" && !hasContent && (
          <p className="text-sm text-slate-400">正在执行，请稍候…</p>
        )}
        {errorMsg && !hasContent && <p className="text-sm text-red-400">❌ {errorMsg}</p>}
        {hasContent && format === "markdown" && !isLikelyPdfBinary(content) ? (
          <ChatMarkdownBody content={content} />
        ) : null}
        {hasContent && (format !== "markdown" || isLikelyPdfBinary(content)) ? (
          <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-200">
            {isLikelyPdfBinary(content)
              ? "当前内容为 PDF 二进制流，请在项目详情或下载后使用 PDF 阅读器打开。"
              : content}
            {genStatus === "generating" ? (
              <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-blue-400 align-middle" />
            ) : null}
          </pre>
        ) : null}
        {hasContent && format === "markdown" && !isLikelyPdfBinary(content) && genStatus === "generating" ? (
          <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-blue-400 align-middle" />
        ) : null}
        <div ref={outputEndRef} />
      </div>
    </>
  );
}
