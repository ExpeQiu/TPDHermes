"use client";

import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import type { BrainstormTurn, BrainstormTurnKind } from "../parse-brainstorm-delivery";

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

function normalizeKind(raw: string | undefined): BrainstormTurnKind {
  const k = (raw || "other").toLowerCase();
  if (
    k === "opening" ||
    k === "speech" ||
    k === "escalate" ||
    k === "consensus" ||
    k === "synthesis" ||
    k === "other"
  ) {
    return k;
  }
  return "other";
}

export function normalizeLiveTurns(
  turns: Array<{
    id?: string;
    kind?: string;
    speaker?: string;
    badge?: string;
    content?: string;
  }>,
): BrainstormTurn[] {
  return turns.map((t, i) => ({
    id: t.id || `turn-${i + 1}`,
    kind: normalizeKind(t.kind),
    speaker: t.speaker || "专家",
    badge: t.badge,
    content: t.content || "",
  }));
}

export function BrainstormTurnCard({
  turn,
  emphasize,
}: {
  turn: BrainstormTurn;
  emphasize?: boolean;
}) {
  const style = KIND_STYLES[turn.kind];
  const initial = turn.speaker.charAt(0) || "?";

  return (
    <article
      className={`rounded-2xl border bg-white/90 p-4 transition-all duration-300 sm:p-5 dark:bg-slate-950/40 ${style.ring} ${
        emphasize ? "ring-1 ring-amber-300/60 dark:ring-amber-600/40" : ""
      }`}
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

export function BrainstormTurnList({
  turns,
  running,
}: {
  turns: BrainstormTurn[];
  running?: boolean;
}) {
  if (turns.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700">
        {running ? "等待第一位专家发言…" : "暂无发言"}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {turns.map((turn, index) => (
        <BrainstormTurnCard
          key={turn.id}
          turn={turn}
          emphasize={running && index === turns.length - 1}
        />
      ))}
      {running ? (
        <div className="flex items-center gap-2 px-1 text-xs text-slate-500">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          下一位专家发言中…
        </div>
      ) : null}
    </div>
  );
}
