"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import type { BrainstormRunResult } from "@/lib/brainstorm-api";
import { parseBrainstormDelivery } from "../parse-brainstorm-delivery";
import { BrainstormTurnList, normalizeLiveTurns } from "./BrainstormTurnList";

type Props = {
  result: BrainstormRunResult;
  projectId: string;
  saving: boolean;
  savedOutputId: string | null;
  saveError: string | null;
  showTrajectory: boolean;
  onToggleTrajectory: () => void;
  onDeposit: () => void;
  onReconfigure: () => void;
};

export function BrainstormResultPanel({
  result,
  projectId,
  saving,
  savedOutputId,
  saveError,
  showTrajectory,
  onToggleTrajectory,
  onDeposit,
  onReconfigure,
}: Props) {
  const turns = useMemo(() => {
    if (result.live_turns && result.live_turns.length > 0) {
      return normalizeLiveTurns(result.live_turns);
    }
    return parseBrainstormDelivery(result.delivery_markdown || "").turns;
  }, [result.delivery_markdown, result.live_turns]);

  const topic =
    parseBrainstormDelivery(result.delivery_markdown || "").topic || undefined;

  return (
    <section className="mt-6 space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/80 p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Delivery
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {result.title || "圆桌 Master Plan"}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              run={result.run_id || "—"} · {result.coordinator} · bridge=
              {result.bridge}
              {result.mock ? " · mock" : " · live"}
              {result.discussion_mode ? ` · ${result.discussion_mode}` : ""}
              {result.consensus_reached
                ? ` · 共识@R${result.stopped_at_round ?? "?"}`
                : ""}
            </p>
            {topic ? (
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {topic}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onReconfigure}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              重新配置
            </button>
            <button
              type="button"
              onClick={onDeposit}
              disabled={saving || !result.delivery_markdown?.trim()}
              className="rounded-xl border border-amber-400 bg-amber-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? "保存中…"
                : savedOutputId
                  ? "已保存（再次保存将更新）"
                  : "保存为项目输出"}
            </button>
            <button
              type="button"
              onClick={onToggleTrajectory}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {showTrajectory ? "收起轨迹" : "查看轨迹"}
            </button>
          </div>
        </div>

        {savedOutputId ? (
          <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">
            已写入项目输出沉淀。
            <Link
              href={`/projects/${projectId}?tab=outputs`}
              className="ml-2 underline underline-offset-2"
            >
              前往查看
            </Link>
            <span className="ml-2 text-slate-400">id={savedOutputId}</span>
          </p>
        ) : null}
        {saveError ? (
          <p className="mt-3 text-xs text-red-700 dark:text-red-300">{saveError}</p>
        ) : null}

        <div className="mt-5 space-y-3">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
            圆桌发言 · {turns.length}
          </p>
          <BrainstormTurnList turns={turns} />
        </div>

        {result.warnings?.length ? (
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {showTrajectory ? (
        <div className="rounded-3xl border border-slate-200 bg-slate-50/80 p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-950/50">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
            Trajectory
          </p>
          <div className="prose prose-slate mt-3 max-w-none dark:prose-invert">
            <ChatMarkdownBody
              content={result.trajectory_markdown || "（无轨迹）"}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
