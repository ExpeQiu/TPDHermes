"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

type LearningSignal = {
  id: string;
  signal_type: string;
  entity_kind: string;
  entity_id?: string;
  entity_label?: string;
  count?: string;
  status?: string;
  payload?: {
    suggestion?: string;
    adoption_rate?: number;
    reason_samples?: string[];
    rewrite_count?: number;
    query?: string;
    collection?: string;
  };
  last_seen_at?: string;
};

type WeeklyReportSummary = {
  week_start?: string;
  learned?: string[];
  pending_confirmations?: string[];
  feedback_stats?: {
    total?: number;
    adoption_rate?: number;
    rewrite_rate?: number;
    by_level?: Record<string, number>;
  };
  open_signals_count?: number;
  generated_at?: string;
};

type FeedbackStats = {
  days: number;
  total: number;
  adoption_rate: number;
  rewrite_rate: number;
  learning_conversion_rate: number;
  kb_miss_rate: number;
  by_level?: Record<string, number>;
  open_signals?: LearningSignal[];
  latest_weekly_report?: WeeklyReportSummary | null;
};

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/50">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function signalTypeLabel(t: string): string {
  const map: Record<string, string> = {
    repeated_correction: "重复纠正",
    low_adoption_scenario: "低采纳场景",
    kb_miss: "KB 空命中",
    skill_underused: "技能低使用",
  };
  return map[t] ?? t;
}

function signalEditHref(sig: LearningSignal): { href: string; label: string } | null {
  if (sig.entity_kind === "scenario" && sig.entity_id) {
    return {
      href: `/create?scenario=${encodeURIComponent(sig.entity_id)}`,
      label: "去改场景",
    };
  }
  if (sig.entity_kind === "project" && sig.entity_id) {
    return {
      href: `/projects/${encodeURIComponent(sig.entity_id)}`,
      label: "去改项目",
    };
  }
  if (sig.signal_type === "kb_miss") {
    const collection = sig.payload?.collection?.trim();
    const href = collection
      ? `/knowledge?collection=${encodeURIComponent(collection)}`
      : "/knowledge";
    return { href, label: "去补知识库" };
  }
  if (sig.signal_type === "skill_underused" && sig.entity_id) {
    return {
      href: `/skills/${encodeURIComponent(sig.entity_id)}`,
      label: "去改技能",
    };
  }
  return null;
}

export default function LearningPageClient() {
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [signals, setSignals] = useState<LearningSignal[]>([]);
  const [report, setReport] = useState<WeeklyReportSummary | null>(null);
  const [reportMeta, setReportMeta] = useState<{ id?: string; week_start?: string; created_at?: string } | null>(
    null,
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [statsRes, signalsRes, reportRes] = await Promise.all([
        apiGet<FeedbackStats>(`/feedback/stats?days=${days}`),
        apiGet<{ items: LearningSignal[] }>("/learning/signals?limit=50"),
        apiGet<{
          report: {
            id: string;
            week_start: string;
            summary: WeeklyReportSummary;
            created_at: string;
          } | null;
        }>("/learning/reports/latest"),
      ]);
      setStats(statsRes);
      setSignals(signalsRes.items ?? []);
      if (reportRes.report) {
        setReport(reportRes.report.summary ?? null);
        setReportMeta({
          id: reportRes.report.id,
          week_start: reportRes.report.week_start,
          created_at: reportRes.report.created_at,
        });
      } else {
        setReport(statsRes.latest_weekly_report ?? null);
        setReportMeta(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAnalyze = async () => {
    setBusy(true);
    try {
      await apiPost("/learning/analyze?days=14", {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析失败");
    } finally {
      setBusy(false);
    }
  };

  const runWeeklyReport = async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ id: string; week_start: string; summary: WeeklyReportSummary }>(
        "/learning/reports/weekly",
        {},
      );
      setReport(res.summary ?? null);
      setReportMeta({ id: res.id, week_start: res.week_start });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成周报失败");
    } finally {
      setBusy(false);
    }
  };

  const resolveSignal = async (signalId: string, status: "ack" | "dismissed" = "ack") => {
    setResolvingId(signalId);
    setError("");
    try {
      await apiPatch(`/learning/signals/${signalId}`, { status });
      setSignals((prev) => prev.filter((s) => s.id !== signalId));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "标记失败");
    } finally {
      setResolvingId(null);
    }
  };

  const pct = (n: number | undefined) =>
    typeof n === "number" ? `${Math.round(n * 1000) / 10}%` : "—";

  const openSignals = useMemo(() => signals.filter((s) => s.status === "open"), [signals]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">系统成长性</p>
            <h1 className="mt-2 text-3xl font-bold">学习中心</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              汇总 Chat 反馈产生的学习信号与周报摘要。经验正文请在{" "}
              <Link href="/knowledge?mode=experience" className="text-blue-600 hover:underline dark:text-blue-400">
                知识库 · 经验库
              </Link>{" "}
              中浏览。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <option value={7}>近 7 天</option>
              <option value={14}>近 14 天</option>
              <option value={30}>近 30 天</option>
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
            >
              刷新
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAnalyze()}
              className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-white dark:bg-slate-700"
            >
              运行分析
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runWeeklyReport()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500"
            >
              生成周报
            </button>
          </div>
        </header>

        {error ? (
          <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : (
          <>
            <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="反馈总数" value={String(stats?.total ?? 0)} hint={`近 ${days} 天`} />
              <MetricCard label="采纳率" value={pct(stats?.adoption_rate)} hint="full + partial×0.5" />
              <MetricCard label="重写率" value={pct(stats?.rewrite_rate)} hint="点击「重写」占比" />
              <MetricCard
                label="KB 空命中率"
                value={pct(stats?.kb_miss_rate)}
                hint="相对反馈量的 miss 信号"
              />
            </section>

            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-2xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/50">
                <h2 className="text-lg font-semibold">本周学习摘要</h2>
                {reportMeta?.week_start ? (
                  <p className="mt-1 text-xs text-slate-500">
                    周期自 {reportMeta.week_start}
                    {reportMeta.created_at ? ` · 更新 ${reportMeta.created_at.slice(0, 19)}` : ""}
                  </p>
                ) : null}
                <div className="mt-4 space-y-4 text-sm">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      已学会
                    </p>
                    {(report?.learned ?? []).length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
                        {(report?.learned ?? []).map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-slate-500">暂无采纳反馈摘要</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                      待确认 / 建议动作
                    </p>
                    {(report?.pending_confirmations ?? []).length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700 dark:text-slate-300">
                        {(report?.pending_confirmations ?? []).map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-slate-500">暂无待处理学习项</p>
                    )}
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white/80 p-5 dark:border-slate-800 dark:bg-slate-900/50">
                <h2 className="text-lg font-semibold">开放学习信号</h2>
                <p className="mt-1 text-xs text-slate-500">{openSignals.length} 条待处理</p>
                <ul className="mt-4 max-h-80 space-y-3 overflow-y-auto text-sm">
                  {openSignals.length === 0 ? (
                    <li className="text-slate-500">暂无开放信号</li>
                  ) : (
                    openSignals.map((sig) => {
                      const edit = signalEditHref(sig);
                      const resolving = resolvingId === sig.id;
                      return (
                      <li
                        key={sig.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">
                              {signalTypeLabel(sig.signal_type)}
                            </span>
                            <span className="font-medium">{sig.entity_label ?? sig.entity_id}</span>
                            {sig.count ? (
                              <span className="text-xs text-slate-500">×{sig.count}</span>
                            ) : null}
                          </div>
                          {sig.payload?.suggestion ? (
                            <p className="mt-1 text-xs text-slate-500">{sig.payload.suggestion}</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          {edit ? (
                            <Link
                              href={edit.href}
                              className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                            >
                              {edit.label}
                            </Link>
                          ) : null}
                          <button
                            type="button"
                            disabled={resolving || busy}
                            onClick={() => void resolveSignal(sig.id)}
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            {resolving ? "处理中…" : "标记已处理"}
                          </button>
                        </div>
                      </li>
                      );
                    })
                  )}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
