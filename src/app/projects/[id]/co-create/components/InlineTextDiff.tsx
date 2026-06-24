"use client";

import { useMemo } from "react";
import { computeLineDiff, hasDiffChanges, type DiffLineType } from "@/lib/text-line-diff";

const LINE_STYLES: Record<DiffLineType, string> = {
  equal: "text-slate-800 dark:text-slate-200",
  remove:
    "bg-red-100/90 text-red-900 line-through decoration-red-400/70 dark:bg-red-950/45 dark:text-red-200",
  add: "bg-emerald-100/90 text-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-200",
};

const LINE_MARKERS: Record<DiffLineType, string> = {
  equal: " ",
  remove: "−",
  add: "+",
};

type Props = {
  before: string;
  after: string;
  className?: string;
  showLegend?: boolean;
};

export function InlineTextDiff({ before, after, className = "", showLegend = false }: Props) {
  const lines = useMemo(() => computeLineDiff(before, after), [before, after]);
  const changed = useMemo(() => hasDiffChanges(lines), [lines]);

  return (
    <div className={className}>
      {showLegend && changed ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-red-100 dark:bg-red-950/45" />
            删除
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded bg-emerald-100 dark:bg-emerald-950/45" />
            修改/新增
          </span>
        </div>
      ) : null}
      <div className="select-text font-mono text-xs leading-relaxed">
        {lines.map((line, index) => (
          <div
            key={`${line.type}-${index}`}
            className={`whitespace-pre-wrap break-words px-1 ${LINE_STYLES[line.type]}`}
          >
            <span className="mr-2 inline-block w-3 select-none opacity-50" aria-hidden>
              {LINE_MARKERS[line.type]}
            </span>
            {line.text || "\u00a0"}
          </div>
        ))}
      </div>
    </div>
  );
}
