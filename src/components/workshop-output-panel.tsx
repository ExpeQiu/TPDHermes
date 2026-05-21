"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  isLikelyPdfBinary,
  triggerWorkshopOutputDownload,
  workshopOutputFormatLabel,
  type WorkshopOutputArtifact,
  type WorkshopOutputFormat,
} from "@/lib/workshop-output-artifact";
import {
  accentAmber,
  accentBlueSoft,
  accentEmerald,
  accentRed,
  accentRedSoft,
  accentViolet,
} from "@/lib/theme-text";

type GenStatus = "idle" | "generating" | "done" | "error";

function formatIconTint(format: WorkshopOutputFormat): string {
  switch (format) {
    case "pdf":
      return `${accentRed} opacity-90`;
    case "html":
      return `${accentViolet} opacity-90`;
    case "json":
      return `${accentAmber} opacity-90`;
    case "markdown":
      return `${accentEmerald} opacity-90`;
    default:
      return "text-slate-600 dark:text-slate-300";
  }
}

function FormatIcon({
  format,
  className = "h-10 w-10",
}: {
  format: WorkshopOutputFormat;
  className?: string;
}) {
  const base = `${className} ${formatIconTint(format)}`;
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

function ArtifactIconTile({
  artifact,
  active,
  onSelect,
}: {
  artifact: WorkshopOutputArtifact;
  active: boolean;
  onSelect: () => void;
}) {
  const formatLabel = workshopOutputFormatLabel(artifact.format);
  const label = artifact.title?.trim() || formatLabel;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-[5.5rem] shrink-0 flex-col items-center gap-1.5 rounded-xl border bg-gradient-to-b from-slate-100 to-slate-200 px-2 py-3 shadow-inner transition dark:from-slate-900 dark:to-slate-950 ${
        active
          ? "border-blue-500/60 ring-1 ring-blue-500/40"
          : "border-slate-300 dark:border-slate-600/80 hover:border-blue-500/40 hover:ring-1 hover:ring-blue-500/20"
      }`}
      aria-label={`查看 ${label}`}
      aria-pressed={active}
    >
      <FormatIcon format={artifact.format} className="h-9 w-9" />
      <span className="line-clamp-2 w-full text-center text-[10px] leading-tight text-slate-700 dark:text-slate-300">
        {label}
      </span>
      <span className="rounded border border-slate-300 dark:border-slate-700/80 px-1.5 py-0.5 text-[9px] text-slate-500">
        {formatLabel}
      </span>
    </button>
  );
}

function detailBody(content: string, format: WorkshopOutputFormat, genStatus: GenStatus) {
  if (format === "markdown" && !isLikelyPdfBinary(content)) {
    return (
      <>
        <ChatMarkdownBody content={content} />
        {genStatus === "generating" ? (
          <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-blue-400 align-middle" />
        ) : null}
      </>
    );
  }

  let text = content;
  if (isLikelyPdfBinary(content)) {
    text = "当前内容为 PDF 二进制流，请下载后使用 PDF 阅读器打开。";
  } else if (format === "json") {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // keep raw
    }
  }

  return (
    <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-800 dark:text-slate-200">
      {text}
      {genStatus === "generating" ? (
        <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-blue-400 align-middle" />
      ) : null}
    </pre>
  );
}

export function WorkshopOutputPanel({
  artifacts,
  genStatus,
  errorMsg,
  outputEndRef,
  defaultFormat = "markdown",
}: {
  artifacts: WorkshopOutputArtifact[];
  genStatus: GenStatus;
  errorMsg: string;
  outputEndRef?: RefObject<HTMLDivElement | null>;
  defaultFormat?: WorkshopOutputFormat;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const readyArtifacts = useMemo(
    () => artifacts.filter((a) => a.content.trim()),
    [artifacts],
  );

  const selectedArtifact = useMemo(() => {
    if (readyArtifacts.length === 0) return null;
    return readyArtifacts.find((a) => a.id === selectedId) ?? readyArtifacts[readyArtifacts.length - 1];
  }, [readyArtifacts, selectedId]);

  useEffect(() => {
    if (readyArtifacts.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) =>
      prev && readyArtifacts.some((a) => a.id === prev) ? prev : readyArtifacts[readyArtifacts.length - 1].id,
    );
  }, [readyArtifacts]);

  const scrollToDetail = useCallback(() => {
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const emptyHint = useMemo(() => {
    if (errorMsg) return errorMsg;
    if (genStatus === "generating") return "执行中，等待产出…";
    return "尚未执行。开始生成后将显示产出文件。";
  }, [errorMsg, genStatus]);

  const onDownloadSelected = useCallback(() => {
    if (!selectedArtifact) return;
    triggerWorkshopOutputDownload(
      selectedArtifact.content,
      selectedArtifact.format,
      selectedArtifact.title,
    );
  }, [selectedArtifact]);

  const selectedFormatLabel = selectedArtifact
    ? workshopOutputFormatLabel(selectedArtifact.format)
    : workshopOutputFormatLabel(defaultFormat);

  return (
    <>
      <div className="mb-3 rounded-2xl border border-slate-300 dark:border-slate-700/90 bg-slate-100 dark:bg-slate-900/70 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">产出文件</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {readyArtifacts.length > 1
                ? `${readyArtifacts.length} 个文件 · 点击图标查看下方详情`
                : `${selectedFormatLabel} · 点击图标查看下方详情`}
            </p>
          </div>
          <button
            type="button"
            onClick={onDownloadSelected}
            disabled={!selectedArtifact}
            title={selectedArtifact ? `下载 ${selectedFormatLabel}` : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-200/80 dark:bg-slate-800/80 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 transition hover:bg-slate-300 dark:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            下载
          </button>
        </div>

        {readyArtifacts.length === 0 ? (
          <div className="mt-2 flex min-h-[6.5rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-600/50 bg-slate-100/60 dark:bg-slate-950/40 px-4 py-6">
            <FormatIcon format={defaultFormat} className="h-10 w-10 opacity-40" />
            <p className="max-w-xs text-center text-sm text-slate-500">{emptyHint}</p>
          </div>
        ) : readyArtifacts.length === 1 ? (
          <button
            type="button"
            onClick={scrollToDetail}
            className="mt-2 flex min-h-[6.5rem] w-full flex-col items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-600/80 bg-gradient-to-b from-slate-900 to-slate-950 px-4 py-5 shadow-inner transition hover:border-blue-500/50 hover:ring-1 hover:ring-blue-500/30"
            aria-label="查看产出物详情"
          >
            <FormatIcon format={readyArtifacts[0].format} className="h-12 w-12" />
            <p className="line-clamp-1 text-sm font-medium text-slate-800 dark:text-slate-200">
              {readyArtifacts[0].title?.trim() || selectedFormatLabel}
            </p>
            <p className={`text-[11px] ${accentBlueSoft} opacity-90`}>点击查看详情 ↓</p>
          </button>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {readyArtifacts.map((artifact) => (
              <ArtifactIconTile
                key={artifact.id}
                artifact={artifact}
                active={artifact.id === selectedArtifact?.id}
                onSelect={() => {
                  setSelectedId(artifact.id);
                  scrollToDetail();
                }}
              />
            ))}
          </div>
        )}
      </div>

      <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">内容详情</p>
      <div
        ref={detailRef}
        className="min-h-48 max-h-[min(32rem,calc(100vh-12rem))] scroll-mt-4 overflow-y-auto rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 p-5 xl:min-h-72"
      >
        {genStatus === "idle" && !selectedArtifact && (
          <p className="text-sm text-slate-500">点击「开始生成」后在此查看完整产出；或点击上方文件图标定位到此处。</p>
        )}
        {genStatus === "generating" && !selectedArtifact && (
          <p className="text-sm text-slate-400">正在执行，请稍候…</p>
        )}
        {errorMsg && !selectedArtifact && <p className={`text-sm ${accentRedSoft}`}>❌ {errorMsg}</p>}
        {selectedArtifact
          ? detailBody(selectedArtifact.content, selectedArtifact.format, genStatus)
          : null}
        <div ref={outputEndRef} />
      </div>
    </>
  );
}
