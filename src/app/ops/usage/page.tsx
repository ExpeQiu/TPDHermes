"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { trackUsage } from "@/lib/usage-tracker";

type FeatureUsageRow = {
  feature: string;
  event_count: number;
  user_count: number;
  session_count: number;
};

type UserUsageRow = {
  user_id: string;
  event_count: number;
  feature_count: number;
};

type FeatureUserFrequencyRow = {
  feature: string;
  user_id: string;
  event_count: number;
};

type DailyUsageRow = {
  date: string;
  event_count: number;
  user_count: number;
};

type SkillUsageRow = {
  skill_name: string;
  call_count: number;
  user_count: number;
  feedback_count: number;
  adoption_rate: number | null;
  full_count: number;
  partial_count: number;
  reject_count: number;
};

type DailyConversationRow = {
  date: string;
  session_count: number;
  avg_rounds: number;
};

type ChatWordTermRow = {
  text: string;
  count: number;
  weight: number;
};

type UsageOverviewResponse = {
  days: number;
  total_events: number;
  total_users: number;
  skills_total_calls: number;
  skills_feedback_count: number;
  skills_overall_adoption_rate: number | null;
  chat_run_count: number;
  chat_session_count: number;
  avg_conversation_rounds: number | null;
  max_conversation_rounds: number;
  new_conversation_count: number;
  chat_wordcloud_mode: string;
  feature_usage: FeatureUsageRow[];
  user_usage: UserUsageRow[];
  feature_user_frequency: FeatureUserFrequencyRow[];
  daily_usage: DailyUsageRow[];
  skill_usage: SkillUsageRow[];
  daily_conversation: DailyConversationRow[];
  chat_wordcloud_terms: ChatWordTermRow[];
};

function wordCloudFontSize(weight: number): string {
  const min = 0.8;
  const max = 1.75;
  return `${min + Math.max(0, Math.min(1, weight)) * (max - min)}rem`;
}

function formatRounds(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return value.toFixed(1);
}

function formatPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

export default function FeatureUsagePage() {
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState<UsageOverviewResponse | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<UsageOverviewResponse>(`/metrics/feature-usage?days=${days}&top=20`);
      setData(result);
      setLastUpdated(new Date());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载统计失败");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    trackUsage({
      eventName: "usage_dashboard_view",
      feature: "usage_dashboard",
      action: "view",
      properties: { days },
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const topFeature = useMemo(() => data?.feature_usage[0] ?? null, [data]);
  const topSkill = useMemo(() => data?.skill_usage[0] ?? null, [data]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <Link href="/" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
              ← 返回首页
            </Link>
            <h1 className="mt-2 text-3xl font-bold">功能使用统计</h1>
            <p className="mt-1 text-sm text-slate-500">
              用于查看功能使用率、用户分布和使用频率。
              {lastUpdated ? ` 最近更新 ${lastUpdated.toLocaleTimeString()}，点击「刷新」获取最新数据。` : " 点击「刷新」加载数据。"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/70 px-3 py-2 text-sm"
            >
              <option value={3}>近 3 天</option>
              <option value={7}>近 7 天</option>
              <option value={14}>近 14 天</option>
              <option value={30}>近 30 天</option>
            </select>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              刷新
            </button>
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-600/40 bg-red-600/20 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="总事件数" value={String(data?.total_events ?? 0)} hint={`近 ${days} 天`} />
          <MetricCard label="活跃用户" value={String(data?.total_users ?? 0)} hint="有行为记录的用户" />
          <MetricCard label="功能数" value={String(data?.feature_usage.length ?? 0)} hint="被使用的功能数" />
          <MetricCard
            label="最高频功能"
            value={topFeature?.feature ?? "-"}
            hint={topFeature ? `${topFeature.event_count} 次` : "暂无数据"}
          />
          <MetricCard
            label="Skills 调用"
            value={String(data?.skills_total_calls ?? 0)}
            hint={topSkill ? `最高频 ${topSkill.skill_name}` : "工坊编排执行次数"}
          />
          <MetricCard
            label="Skills 采纳率"
            value={formatPct(data?.skills_overall_adoption_rate)}
            hint={`${data?.skills_feedback_count ?? 0} 条可关联反馈 · full + partial×0.5`}
          />
          <MetricCard
            label="平均对话轮次"
            value={formatRounds(data?.avg_conversation_rounds)}
            hint={`${data?.chat_session_count ?? 0} 个会话 · 最高 ${data?.max_conversation_rounds ?? 0} 轮`}
          />
          <MetricCard
            label="Chat 请求数"
            value={String(data?.chat_run_count ?? 0)}
            hint="entrypoint=chat 的编排 run"
          />
        </div>

        {loading ? <p className="text-sm text-slate-500">加载中…</p> : null}

        {!loading && data ? (
          <div className="space-y-6">
            <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
              <h2 className="text-lg font-semibold">Skills 调用与采纳率</h2>
              <p className="mt-1 text-xs text-slate-500">
                调用次数来自工坊编排 run；采纳率来自可关联到 run 的用户反馈（full / partial / reject）。
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Skill</th>
                      <th className="py-2 pr-3">调用次数</th>
                      <th className="py-2 pr-3">用户数</th>
                      <th className="py-2 pr-3">反馈数</th>
                      <th className="py-2 pr-3">采纳率</th>
                      <th className="py-2 pr-3">full</th>
                      <th className="py-2 pr-3">partial</th>
                      <th className="py-2 pr-3">reject</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.skill_usage.length > 0 ? (
                      data.skill_usage.map((row) => (
                        <tr key={row.skill_name} className="border-t border-slate-300/60 dark:border-slate-700/60">
                          <td className="py-2 pr-3 font-mono text-xs">{row.skill_name}</td>
                          <td className="py-2 pr-3">{row.call_count}</td>
                          <td className="py-2 pr-3">{row.user_count}</td>
                          <td className="py-2 pr-3">{row.feedback_count}</td>
                          <td className="py-2 pr-3">{formatPct(row.adoption_rate)}</td>
                          <td className="py-2 pr-3">{row.full_count}</td>
                          <td className="py-2 pr-3">{row.partial_count}</td>
                          <td className="py-2 pr-3">{row.reject_count}</td>
                        </tr>
                      ))
                    ) : (
                      <tr className="border-t border-slate-300/60 dark:border-slate-700/60">
                        <td className="py-3 text-slate-500" colSpan={8}>
                          近 {days} 天暂无 Skills 工坊调用记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
              <h2 className="text-lg font-semibold">平均对话轮次</h2>
              <p className="mt-1 text-xs text-slate-500">
                基于 chat 编排 run 推断会话（同用户/项目/场景，30 分钟无活动切分）；多轮请求取累计轮次，单轮连续请求按次数累计。
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">日期</th>
                      <th className="py-2 pr-3">会话数</th>
                      <th className="py-2 pr-3">平均轮次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily_conversation.length > 0 ? (
                      data.daily_conversation.map((row) => (
                        <tr key={row.date} className="border-t border-slate-300/60 dark:border-slate-700/60">
                          <td className="py-2 pr-3">{row.date}</td>
                          <td className="py-2 pr-3">{row.session_count}</td>
                          <td className="py-2 pr-3">{row.avg_rounds.toFixed(1)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr className="border-t border-slate-300/60 dark:border-slate-700/60">
                        <td className="py-3 text-slate-500" colSpan={3}>
                          近 {days} 天暂无 chat 对话记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
              <h2 className="text-lg font-semibold">新对话热词（Top 30）</h2>
              <p className="mt-1 text-xs text-slate-500">
                来自对话共创首条消息（无历史 messages）；仅管理员手动刷新时计算，不影响聊天速度。分词：
                {data.chat_wordcloud_mode} · 样本 {data.new_conversation_count} 条
              </p>
              {data.chat_wordcloud_terms.length > 0 ? (
                <>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-slate-300/50 bg-slate-100/80 px-4 py-6 dark:border-slate-700/50 dark:bg-slate-900/40">
                    {data.chat_wordcloud_terms.map((term) => (
                      <span
                        key={term.text}
                        title={`${term.text} · ${term.count} 次`}
                        className="cursor-default font-medium text-blue-700 transition hover:text-blue-500 dark:text-blue-300 dark:hover:text-blue-200"
                        style={{
                          fontSize: wordCloudFontSize(term.weight),
                          opacity: 0.55 + term.weight * 0.45,
                        }}
                      >
                        {term.text}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="text-left text-slate-500">
                        <tr>
                          <th className="py-2 pr-3">#</th>
                          <th className="py-2 pr-3">词语</th>
                          <th className="py-2 pr-3">频次</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.chat_wordcloud_terms.map((term, idx) => (
                          <tr
                            key={`${term.text}_${idx}`}
                            className="border-t border-slate-300/60 dark:border-slate-700/60"
                          >
                            <td className="py-2 pr-3 text-slate-500">{idx + 1}</td>
                            <td className="py-2 pr-3">{term.text}</td>
                            <td className="py-2 pr-3">{term.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm text-slate-500">近 {days} 天暂无可用的新对话首条消息</p>
              )}
            </section>

            <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
              <h2 className="text-lg font-semibold">功能使用率（Top 20）</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">功能</th>
                      <th className="py-2 pr-3">次数</th>
                      <th className="py-2 pr-3">用户数</th>
                      <th className="py-2 pr-3">会话数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.feature_usage.map((row) => (
                      <tr key={row.feature} className="border-t border-slate-300/60 dark:border-slate-700/60">
                        <td className="py-2 pr-3">{row.feature}</td>
                        <td className="py-2 pr-3">{row.event_count}</td>
                        <td className="py-2 pr-3">{row.user_count}</td>
                        <td className="py-2 pr-3">{row.session_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
                <h2 className="text-lg font-semibold">用户使用频率（Top 20）</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-slate-500">
                      <tr>
                        <th className="py-2 pr-3">用户</th>
                        <th className="py-2 pr-3">总次数</th>
                        <th className="py-2 pr-3">覆盖功能数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.user_usage.map((row) => (
                        <tr key={row.user_id} className="border-t border-slate-300/60 dark:border-slate-700/60">
                          <td className="py-2 pr-3 font-mono text-xs">{row.user_id}</td>
                          <td className="py-2 pr-3">{row.event_count}</td>
                          <td className="py-2 pr-3">{row.feature_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
                <h2 className="text-lg font-semibold">按日趋势</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-slate-500">
                      <tr>
                        <th className="py-2 pr-3">日期</th>
                        <th className="py-2 pr-3">事件数</th>
                        <th className="py-2 pr-3">用户数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.daily_usage.map((row) => (
                        <tr key={row.date} className="border-t border-slate-300/60 dark:border-slate-700/60">
                          <td className="py-2 pr-3">{row.date}</td>
                          <td className="py-2 pr-3">{row.event_count}</td>
                          <td className="py-2 pr-3">{row.user_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
              <h2 className="text-lg font-semibold">功能 × 用户 使用频率（Top 40）</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">功能</th>
                      <th className="py-2 pr-3">用户</th>
                      <th className="py-2 pr-3">次数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.feature_user_frequency.map((row, idx) => (
                      <tr key={`${row.feature}_${row.user_id}_${idx}`} className="border-t border-slate-300/60 dark:border-slate-700/60">
                        <td className="py-2 pr-3">{row.feature}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{row.user_id}</td>
                        <td className="py-2 pr-3">{row.event_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
