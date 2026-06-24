"use client";

import type { FileRecommendation } from "@/app/projects/[id]/co-create/co-create-types";

type Props = {
  recommendations: FileRecommendation[];
  onAccept: (rec: FileRecommendation, mode: "round" | "pinned") => void;
  onIgnore: (proposalId: string) => void;
};

export function FileRecommendationCard({ recommendations, onAccept, onIgnore }: Props) {
  if (recommendations.length === 0) return null;

  return (
    <div className="my-3 rounded-xl border border-indigo-300 bg-indigo-50/80 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
      <p className="text-xs font-semibold text-indigo-800 dark:text-indigo-200">推荐引用文件</p>
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
