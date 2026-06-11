"use client";

import { useMemo, useState } from "react";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  type CitationSource,
  citationBadgeClassName,
  citationListTagClassName,
  citationScopeKind,
  citationSourceLabel,
  isWebCitationSource,
  maskCitationMarkers,
  sortCitationsByScope,
} from "@/lib/chat-citations";

function CitationBadge({
  refNum,
  source,
  unresolved,
}: {
  refNum: number;
  source?: CitationSource;
  unresolved?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const chunkLabel =
    source?.chunkIndex != null && !isWebCitationSource(source)
      ? source.chunkCount != null
        ? `片段 ${source.chunkIndex}/${source.chunkCount}`
        : `片段 ${source.chunkIndex}`
      : null;

  const scope = source ? citationScopeKind(source) : "public_kb";

  return (
    <span className="relative inline align-super leading-none">
      <button
        type="button"
        className={`mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-semibold leading-none transition-colors ${citationBadgeClassName(
          scope,
          unresolved,
        )}`}
        aria-label={source ? `引用来源 ${refNum}: ${source.title}` : `未解析引用 ${refNum}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
      >
        {refNum}
      </button>
      {open ? (
        <span
          className="absolute bottom-full left-1/2 z-20 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-slate-300 bg-white p-2.5 text-left shadow-lg dark:border-slate-600 dark:bg-slate-900"
          role="tooltip"
        >
          {source ? (
            <>
              <span className="mb-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {citationSourceLabel(source)}
              </span>
              <span className="block text-xs font-semibold text-slate-900 dark:text-slate-100">
                {source.title || "未命名资料"}
              </span>
              {scope !== "web" && source.collection ? (
                <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                  {source.collection}
                  {chunkLabel ? ` · ${chunkLabel}` : ""}
                </span>
              ) : null}
              {scope === "web" && source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 block truncate text-[10px] text-emerald-700 underline dark:text-emerald-300"
                >
                  {source.url}
                </a>
              ) : null}
              {source.excerpt ? (
                <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
                  {source.excerpt}
                </span>
              ) : null}
            </>
          ) : (
            <span className="block text-[11px] text-amber-800 dark:text-amber-200">
              未找到对应检索片段（ref {refNum}）。可能来源未落库，或编号与 kb_query / 联网检索返回的 ref 不一致。
            </span>
          )}
        </span>
      ) : null}
    </span>
  );
}

function CitationSourcesList({
  citations,
  defaultOpen = false,
}: {
  citations: CitationSource[];
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="mt-2 border-t border-slate-400/40 pt-2 dark:border-slate-500/40"
      open={defaultOpen}
    >
      <summary className="cursor-pointer text-[11px] font-medium text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200">
        引用来源 ({citations.length})
      </summary>
      <ul className="mt-1.5 space-y-1.5">
        {sortCitationsByScope(citations).map((s) => {
          const scope = citationScopeKind(s);
          return (
          <li
            key={`${s.ref}-${s.chunkId}`}
            className="rounded-md bg-slate-200/60 px-2 py-1.5 text-[11px] dark:bg-slate-800/60"
          >
            <span
              className={`mr-1.5 inline-block rounded px-1 py-0.5 text-[10px] font-medium ${citationListTagClassName(
                scope,
              )}`}
            >
              {citationSourceLabel(s)}
            </span>
            <span className="font-semibold text-blue-800 dark:text-blue-200">[{s.ref}]</span>{" "}
            <span className="text-slate-800 dark:text-slate-200">{s.title}</span>
            {scope === "web" && s.url ? (
              <p className="mt-0.5 truncate text-emerald-700 dark:text-emerald-300">{s.url}</p>
            ) : null}
            {s.excerpt ? (
              <p className="mt-0.5 line-clamp-2 text-slate-600 dark:text-slate-400">{s.excerpt}</p>
            ) : null}
          </li>
          );
        })}
      </ul>
    </details>
  );
}

export function ChatMarkdownWithCitations({
  content,
  citations,
  unresolvedCitationRefs,
  streaming = false,
}: {
  content: string;
  citations?: CitationSource[];
  unresolvedCitationRefs?: number[];
  streaming?: boolean;
}) {
  const sourceByRef = useMemo(() => {
    const map = new Map<number, CitationSource>();
    for (const s of citations ?? []) {
      map.set(s.ref, s);
    }
    return map;
  }, [citations]);

  const unresolvedSet = useMemo(
    () => new Set(unresolvedCitationRefs ?? []),
    [unresolvedCitationRefs],
  );

  const hasInlineMarkers = content.includes("[^") || content.includes("{{CITE:");
  // 正文含 [^N] 时始终渲染角标；无溯源元数据则标为未解析（避免 GFM 脚注只显示数字、无来源）
  const showBadges = !streaming && hasInlineMarkers;

  const renderCitation = useMemo(() => {
    if (!showBadges) return undefined;
    return (ref: number) => {
      const source = sourceByRef.get(ref);
      const unresolved = unresolvedSet.has(ref) || !source;
      return <CitationBadge refNum={ref} source={source} unresolved={unresolved} />;
    };
  }, [showBadges, sourceByRef, unresolvedSet]);

  const markdownContent = showBadges ? maskCitationMarkers(content) : content;
  const showSourceList = !streaming && citations && citations.length > 0;

  return (
    <div>
      <ChatMarkdownBody content={markdownContent} renderCitation={renderCitation} />
      {showSourceList ? (
        <CitationSourcesList citations={citations} defaultOpen={!hasInlineMarkers} />
      ) : null}
    </div>
  );
}
