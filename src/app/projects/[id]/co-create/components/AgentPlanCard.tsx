"use client";

import type { AgentPlan, AgentPlanStep } from "@/app/projects/[id]/co-create/co-create-agent-utils";

type Props = {
  plan: AgentPlan;
  compact?: boolean;
};

export function AgentPlanCard({ plan, compact }: Props) {
  if (!plan.steps.length) return null;

  const doneCount = plan.steps.filter((s) => s.status === "done").length;

  return (
    <div className="mb-3 rounded-xl border border-violet-200 bg-violet-50/80 px-3 py-2.5 dark:border-violet-800/60 dark:bg-violet-950/30">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-violet-800 dark:text-violet-200">
          {plan.title ?? "执行计划"}
        </p>
        <span className="text-[10px] text-violet-600 dark:text-violet-300">
          {doneCount}/{plan.steps.length}
        </span>
      </div>
      <ol className={`mt-2 space-y-1.5 ${compact ? "text-[11px]" : "text-xs"}`}>
        {plan.steps.map((step) => (
          <PlanStepRow key={step.id} step={step} />
        ))}
      </ol>
    </div>
  );
}

function PlanStepRow({ step }: { step: AgentPlanStep }) {
  const statusIcon =
    step.status === "done" ? "✓" : step.status === "in_progress" ? "→" : "○";
  const statusClass =
    step.status === "done"
      ? "text-emerald-600 dark:text-emerald-300"
      : step.status === "in_progress"
        ? "text-blue-600 dark:text-blue-300"
        : "text-violet-500 dark:text-violet-400";

  return (
    <li className="flex gap-2">
      <span className={`shrink-0 font-mono ${statusClass}`} aria-hidden>
        {statusIcon}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-violet-900 dark:text-violet-100">{step.title}</p>
        {step.detail ? (
          <p className="mt-0.5 text-violet-700/80 dark:text-violet-200/70">{step.detail}</p>
        ) : null}
      </div>
    </li>
  );
}
