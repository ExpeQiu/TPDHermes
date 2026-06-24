"use client";

import { useEffect, useRef, useState } from "react";
import type { FileRecommendation } from "@/app/projects/[id]/co-create/co-create-types";

const AUTO_COLLAPSE_MS = 5000;

type Props = {
  recommendations: FileRecommendation[];
  onAccept: (rec: FileRecommendation, mode: "round" | "pinned") => void;
  onIgnore: (proposalId: string) => void;
};

export function FileRecommendationCard({ recommendations, onAccept, onIgnore }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recKey = recommendations.map((r) => r.proposalId).join(",");

  useEffect(() => {
    if (recommendations.length === 0) {
      setCollapsed(false);
      return;
    }
    setCollapsed(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCollapsed(true);
      console.info("[co-create] 文件推荐卡片已自动折叠", { count: recommendations.length });
    }, AUTO_COLLAPSE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [recKey, recommendations.length]);

  if (recommendations.length === 0) return null;

  if (collapsed) {
    return (
      <div className="my-3 flex items-center justify-between gap-2 rounded-lg bg-indigo-50/40 px-1 py-1.5 dark:bg-indigo-950/15">
        <p className="truncate text-xs text-indigo-800 dark:text-indigo-200">
          推荐引用文件 · {recommendations.length} 项
        </p>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="shrink-0 rounded-md px-2 py-0.5 text-[10px] text-indigo-700 hover:bg-indigo-100/80 dark:text-indigo-200 dark:hover:bg-indigo-950/50"
        >
          展开
        </button>
      </div>
    );
  }

  return (
    <div className="my-3 rounded-xl border border-indigo-300 bg-indigo-50/80 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-indigo-800 dark:text-indigo-200">推荐引用文件</p>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-indigo-600/80 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
          aria-label="折叠推荐"
        >
          折叠
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {recommendations.map((rec) => (
          <li key={rec.proposalId} className="rounded-lg bg-white/70 p-2 dark:bg-slate-900/50">
            <p className="text-sm font-medium">{rec.fileName}</p>
            <p className="text-xs text-slate-500">{rec.reason}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => onAccept(rec, "round")}
                className="rounded-md bg-indigo-600 px-2 py-1 text-[10px] text-white"
              >
                加入本轮
              </button>
              <button
                type="button"
                onClick={() => onAccept(rec, "pinned")}
                className="rounded-md border px-2 py-1 text-[10px]"
              >
                固定引用
              </button>
              <button
                type="button"
                onClick={() => onIgnore(rec.proposalId)}
                className="rounded-md px-2 py-1 text-[10px] text-slate-500"
              >
                忽略
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
