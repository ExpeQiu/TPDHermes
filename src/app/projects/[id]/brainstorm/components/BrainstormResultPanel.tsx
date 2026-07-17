"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import type { BrainstormRunResult } from "@/lib/brainstorm-api";
import {
  parseBrainstormDelivery,
  type BrainstormTurn,
  type BrainstormTurnKind,
} from "../parse-brainstorm-delivery";

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

const KIND_STYLES: Record<
  BrainstormTurnKind,
  { avatar: string; ring: string }
> = {
  opening: {
    avatar: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
    ring: "border-indigo-200/80 dark:border-indigo-800/50",
  },
  speech: {
    avatar: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
    ring: "border-slate-200 dark:border-slate-700",
  },
  escalate: {
    avatar: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200",
    ring: "border-violet-200/80 dark:border-violet-800/40",
  },
  consensus: {
    avatar: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
    ring: "border-emerald-200/80 dark:border-emerald-800/40",
  },
  synthesis: {
    avatar: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
    ring: "border-amber-300/70 dark:border-amber-700/40",
  },
  other: {
    avatar: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    ring: "border-slate-200 dark:border-slate-700",
  },
};

function TurnCard({
  turn,
  visible,
}: {
  turn: BrainstormTurn;
  visible: boolean;
}) {
  const style = KIND_STYLES[turn.kind];
  const initial = turn.speaker.charAt(0) || "?";

  return (
    <article
      className={`rounded-2xl border bg-white/90 p-4 transition-all duration-500 sm:p-5 dark:bg-slate-950/40 ${style.ring} ${
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0"
      }`}
      aria-hidden={!visible}
    >
      <header className="mb-3 flex items-start gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium ${style.avatar}`}
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {turn.speaker}
            </h3>
            {turn.badge ? (
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {turn.badge}
              </span>
            ) : null}
          </div>
        </div>
      </header>
      <div className="pl-0 sm:pl-12">
        <ChatMarkdownBody content={turn.content} />
      </div>
    </article>
  );
}

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
  const parsed = useMemo(
    () => parseBrainstormDelivery(result.delivery_markdown || ""),
    [result.delivery_markdown],
  );

  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    setVisibleCount(0);
    if (parsed.turns.length === 0) return;

    let cancelled = false;
    let shown = 0;
    console.info("[brainstorm] 开始逐条展示发言", {
      turnCount: parsed.turns.length,
      runId: result.run_id,
    });

    const tick = () => {
      if (cancelled) return;
      shown += 1;
      setVisibleCount(shown);
      if (shown < parsed.turns.length) {
        window.setTimeout(tick, shown === 1 ? 180 : 220);
      } else {
        console.info("[brainstorm] 发言逐条展示完成", { shown });
      }
    };

    const starter = window.setTimeout(tick, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(starter);
    };
  }, [parsed.turns, result.run_id]);

  return (
    <section className="mt-6 space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white/80 p-5 sm:p-6 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
              Delivery
            </p>
            <h2 className="mt-1 text-xl font-semibold">
              {result.title || parsed.title || "圆桌 Master Plan"}
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
            {parsed.topic ? (
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {parsed.topic}
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
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              圆桌发言 · {Math.min(visibleCount, parsed.turns.length)}/
              {parsed.turns.length}
            </p>
          </div>
          {parsed.turns.map((turn, index) => (
            <TurnCard
              key={turn.id}
              turn={turn}
              visible={index < visibleCount}
            />
          ))}
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
