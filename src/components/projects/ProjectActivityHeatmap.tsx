"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiGet } from "@/lib/api";
import {
  buildActivityCalendar,
  shanghaiToday,
  type ActivityDay,
} from "@/lib/project-activity-calendar";

const LEVEL_CLASS = [
  "bg-[#ebedf0]",
  "bg-[#9be9a8]",
  "bg-[#40c463]",
  "bg-[#30a14e]",
  "bg-[#216e39]",
] as const;

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", ""];

type ActivityResponse = {
  days: ActivityDay[];
  total: number;
};

export type ActivityLink = {
  href: string;
  label: string;
};

export default function ProjectActivityHeatmap({
  projectId,
  links,
}: {
  projectId: string;
  links: ActivityLink[];
}) {
  const [days, setDays] = useState<ActivityDay[]>([]);
  const [selectedYear, setSelectedYear] = useState(() => Number(shanghaiToday().slice(0, 4)));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<ActivityResponse>(`/projects/${projectId}/activity`)
      .then((payload) => {
        if (cancelled) return;
        setDays(payload.days ?? []);
        console.info("[project] activity loaded", {
          project_id: projectId,
          total: payload.total,
          active_days: payload.days?.length ?? 0,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "活跃度加载失败";
        console.warn("[project] activity load failed", { project_id: projectId, error: message });
        setError(message);
        setDays([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const calendar = useMemo(
    () => buildActivityCalendar(days, selectedYear),
    [days, selectedYear],
  );

  return (
    <div className="rounded-3xl border border-slate-300 bg-slate-200 p-4 text-slate-900 sm:p-5 dark:border-slate-600 dark:bg-slate-100 dark:text-slate-900">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-slate-600">
            <span className="text-base font-semibold text-slate-900">{loading ? "…" : calendar.total}</span>
            {" "}
            次活动 · {calendar.label}
          </p>

          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

          <div className="mt-3 overflow-x-auto">
            <div
              className="grid min-w-[28rem] gap-[3px]"
              style={{
                gridTemplateColumns: `1.1rem repeat(${Math.max(calendar.weeks.length, 1)}, minmax(0, 1fr))`,
              }}
            >
              <span />
              {calendar.weeks.map((week) => (
                <span
                  key={`m-${week.days[0]?.date ?? week.monthLabel}`}
                  className="overflow-visible whitespace-nowrap text-[10px] leading-none text-slate-400"
                >
                  {week.monthLabel}
                </span>
              ))}
              {WEEKDAY_LABELS.map((label, row) => (
                <div key={label || `row-${row}`} className="contents">
                  <span className="text-[10px] leading-none text-slate-400">{label}</span>
                  {calendar.weeks.map((week) => {
                    const cell = week.days[row];
                    if (!cell) return <span key={`${row}-empty`} />;
                    const title = cell.inRange
                      ? `${cell.date} · ${cell.count} 次活动`
                      : cell.date;
                    return (
                      <span
                        key={cell.date}
                        title={title}
                        className={`aspect-square w-full rounded-[2px] ${
                          cell.inRange ? LEVEL_CLASS[cell.level] : "bg-slate-300/50"
                        }`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <p>按输出、附件、执行与操作统计</p>
            <div className="flex shrink-0 items-center gap-1">
              <span>少</span>
              {LEVEL_CLASS.map((tone) => (
                <span key={tone} className={`h-2.5 w-2.5 rounded-[2px] ${tone}`} />
              ))}
              <span>多</span>
            </div>
          </div>
        </div>

        <div className="flex w-14 shrink-0 flex-col gap-1">
          {calendar.years.map((year) => {
            const active = year === selectedYear;
            return (
              <button
                key={year}
                type="button"
                onClick={() => setSelectedYear(year)}
                className={`rounded-md px-2 py-1 text-xs font-medium transition ${
                  active
                    ? "bg-blue-600 text-white"
                    : "text-slate-500 hover:bg-white hover:text-slate-900"
                }`}
              >
                {year}
              </button>
            );
          })}
        </div>
      </div>

      {links.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-300 pt-3">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 transition hover:border-blue-500 hover:text-slate-900"
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
