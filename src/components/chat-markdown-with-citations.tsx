"use client";

import { useMemo, useState } from "react";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  type CitationSource,
  collectionShortName,
  splitContentWithCitations,
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
    source?.chunkIndex != null
      ? source.chunkCount != null
        ? `片段 ${source.chunkIndex}/${source.chunkCount}`
        : `片段 ${source.chunkIndex}`
      : null;

  return (
    <span className="relative inline-block align-super leading-none">
      <button
        type="button"
        className={`mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-semibold leading-none transition-colors ${
          unresolved
            ? "bg-amber-200 text-amber-900 hover:bg-amber-300 dark:bg-amber-900/60 dark:text-amber-100"
            : "bg-blue-200/90 text-blue-900 hover:bg-blue-300 dark:bg-blue-900/70 dark:text-blue-100"
        }`}
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
              <span className="block text-xs font-semibold text-slate-900 dark:text-slate-100">
                {source.title || "未命名资料"}
              </span>
              <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                {collectionShortName(source.collection)}
                {chunkLabel ? ` · ${chunkLabel}` : ""}
              </span>
              {source.excerpt ? (
                <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
                  {source.excerpt}
                </span>
              ) : null}
            </>
          ) : (
            <span className="block text-[11px] text-amber-800 dark:text-amber-200">
              未找到对应检索片段（ref {refNum}）
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
        {citations.map((s) => (
          <li
            key={`${s.ref}-${s.chunkId}`}
            className="rounded-md bg-slate-200/60 px-2 py-1.5 text-[11px] dark:bg-slate-800/60"
          >
            <span className="font-semibold text-blue-800 dark:text-blue-200">[{s.ref}]</span>{" "}
            <span className="text-slate-800 dark:text-slate-200">{s.title}</span>
            {s.excerpt ? (
              <p className="mt-0.5 line-clamp-2 text-slate-600 dark:text-slate-400">{s.excerpt}</p>
            ) : null}
          </li>
        ))}
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

  const hasInlineMarkers = content.includes("[^");
  const showBadges =
    !streaming && hasInlineMarkers && ((citations?.length ?? 0) > 0 || (unresolvedCitationRefs?.length ?? 0) > 0);

  const segments = useMemo(
    () => (showBadges ? splitContentWithCitations(content) : null),
    [content, showBadges],
  );

  if (!showBadges || !segments) {
    const showSourceList = !streaming && citations && citations.length > 0;
    return (
      <div>
        <ChatMarkdownBody content={content} />
        {showSourceList ? (
          <CitationSourcesList citations={citations} defaultOpen={!hasInlineMarkers} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="text-sm leading-relaxed break-words">
      {segments.map((seg, idx) => {
        if (seg.kind === "text") {
          if (!seg.value) return null;
          return <ChatMarkdownBody key={`t-${idx}`} content={seg.value} />;
        }
        const source = sourceByRef.get(seg.ref);
        const unresolved = unresolvedSet.has(seg.ref) || !source;
        return (
          <CitationBadge
            key={`c-${idx}-${seg.ref}`}
            refNum={seg.ref}
            source={source}
            unresolved={unresolved}
          />
        );
      })}
      {citations && citations.length > 0 ? <CitationSourcesList citations={citations} /> : null}
    </div>
  );
}
