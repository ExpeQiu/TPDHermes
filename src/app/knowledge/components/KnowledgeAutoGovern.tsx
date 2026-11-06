"use client";

import { useEffect, useState } from "react";

import { apiGet, apiPost, apiPut } from "@/lib/api";
import { kbDomainLabel } from "@/lib/ui-labels";

interface PolicyItem {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface GovernNode {
  from_domain: string;
  from_folder: string;
  to_domain: string;
  to_folder: string;
  reasons: string[];
  decision?: string;
  doc_count: number;
}

interface GovernSchedule {
  enabled: boolean;
  cadence: "daily" | "weekly" | "monthly";
  run_time: string;
  weekday: number;
  month_day: number;
  agent_batch: number;
  policy_ids: string[];
}

interface GovernResult {
  ok: boolean;
  dry_run: boolean;
  eligible_domains: string[];
  nodes: GovernNode[];
  doc_count: number;
  updated_rows: number;
  agent_pending?: number;
  agent_applied?: number;
  advisor?: string;
}

export default function KnowledgeAutoGovern({ onCompleted }: { onCompleted?: () => void }) {
  const [policies, setPolicies] = useState<PolicyItem[]>([]);
  const [policyId, setPolicyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GovernResult | null>(null);
  const [schedule, setSchedule] = useState<GovernSchedule | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiGet<{ items: PolicyItem[] }>("/kb/policies/?status=published")
      .then((data) => {
        if (cancelled) return;
        const items = data.items || [];
        setPolicies(items);
        setPolicyId((current) => current || items[0]?.id || "");
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "策略加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiGet<GovernSchedule>("/kb/policies/govern-schedule")
      .then((data) => {
        if (!cancelled) setSchedule(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "定时配置加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSchedule = async () => {
    if (!schedule) return;
    setScheduleSaving(true);
    setScheduleMessage(null);
    setError(null);
    try {
      const saved = await apiPut<GovernSchedule>("/kb/policies/govern-schedule", {
        enabled: schedule.enabled,
        cadence: schedule.cadence,
        run_time: schedule.run_time,
        weekday: Number(schedule.weekday),
        month_day: Number(schedule.month_day),
        agent_batch: Number(schedule.agent_batch),
        policy_ids: schedule.policy_ids,
      });
      setSchedule(saved);
      setScheduleMessage("定时配置已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "定时配置保存失败");
    } finally {
      setScheduleSaving(false);
    }
  };

  const run = async (dryRun: boolean, consultAgent = false) => {
    if (!policyId) return;
    setRunning(true);
    setError(null);
    try {
      const data = await apiPost<GovernResult>(
        `/kb/policies/${encodeURIComponent(policyId)}/auto-govern`,
        { dry_run: dryRun, consult_agent: consultAgent },
      );
      setResult(data);
      if (!dryRun) onCompleted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "自动治理失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
        <p className="text-sm font-medium text-slate-900 dark:text-white">按策略自动归位</p>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          找出未设置业务域、缺少目录，或不在策略允许范围内的节点。只有一个允许业务域、或业务域已经合法时，按规则直接归位。多个允许业务域且当前域无法确定的文档，交给 Hermes 判断后再写回。
        </p>
        <label className="mt-3 block text-xs">
          <span className="text-slate-500">已发布策略</span>
          <select
            value={policyId}
            disabled={loading || policies.length === 0}
            onChange={(e) => {
              setPolicyId(e.target.value);
              setResult(null);
            }}
            className="mt-1 w-full max-w-md rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            {policies.length === 0 ? <option value="">没有已发布策略</option> : null}
            {policies.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{item.code}）
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!policyId || running}
            onClick={() => void run(true)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {running ? "处理中…" : "预览需治理节点"}
          </button>
          <button
            type="button"
            disabled={!policyId || running || !result?.doc_count}
            onClick={() => void run(false)}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            按规则归位
          </button>
          <button
            type="button"
            disabled={!policyId || running || !result?.doc_count}
            onClick={() => void run(false, true)}
            className="rounded-lg border border-slate-900 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-40 dark:border-white dark:text-white dark:hover:bg-slate-800"
          >
            含 Hermes 判断并执行
          </button>
        </div>
        {!loading && policies.length === 0 ? (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">
            先在「策略」里创建并发布一条策略，且配置 eligible_domains。
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
        <p className="text-sm font-medium text-slate-900 dark:text-white">定时治理</p>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          到点后按所选策略治理。不选策略时覆盖全部已发布策略。已保存的值不会被环境变量盖回。
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={Boolean(schedule?.enabled)}
            disabled={!schedule || scheduleSaving}
            onChange={(e) =>
              setSchedule((current) => (current ? { ...current, enabled: e.target.checked } : current))
            }
          />
          启用定时治理
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="block text-xs sm:col-span-2 xl:col-span-4">
            <span className="text-slate-500">适用的策略</span>
            <div className="mt-1 grid gap-2 sm:grid-cols-2">
              {policies.map((item) => {
                const checked = Boolean(schedule?.policy_ids.includes(item.id));
                return (
                  <label
                    key={item.id}
                    className="flex items-start gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      disabled={!schedule || scheduleSaving}
                      onChange={(e) =>
                        setSchedule((current) => {
                          if (!current) return current;
                          const policy_ids = e.target.checked
                            ? [...current.policy_ids, item.id]
                            : current.policy_ids.filter((id) => id !== item.id);
                          return { ...current, policy_ids };
                        })
                      }
                    />
                    <span>
                      {item.name}
                      <span className="ml-1 text-slate-500">（{item.code}）</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <label className="block text-xs">
            <span className="text-slate-500">每月 / 每周 / 每日</span>
            <select
              value={schedule?.cadence ?? "daily"}
              disabled={!schedule || scheduleSaving}
              onChange={(e) =>
                setSchedule((current) =>
                  current ? { ...current, cadence: e.target.value as GovernSchedule["cadence"] } : current,
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
            {schedule?.cadence === "weekly" ? (
              <select
                value={schedule.weekday}
                disabled={scheduleSaving}
                onChange={(e) =>
                  setSchedule((current) =>
                    current ? { ...current, weekday: Number(e.target.value) } : current,
                  )
                }
                className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            ) : null}
            {schedule?.cadence === "monthly" ? (
              <input
                aria-label="每月几号"
                placeholder="几号"
                type="number"
                min={1}
                max={28}
                value={schedule.month_day}
                disabled={scheduleSaving}
                onChange={(e) =>
                  setSchedule((current) =>
                    current ? { ...current, month_day: Number(e.target.value) } : current,
                  )
                }
                className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            ) : null}
          </label>
          <label className="block text-xs">
            <span className="text-slate-500">时间</span>
            <input
              type="time"
              value={schedule?.run_time ?? "02:00"}
              disabled={!schedule || scheduleSaving}
              onChange={(e) =>
                setSchedule((current) => (current ? { ...current, run_time: e.target.value } : current))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="block text-xs">
            <span className="text-slate-500">每批次数量</span>
            <input
              type="number"
              min={1}
              max={50}
              value={schedule?.agent_batch ?? ""}
              disabled={!schedule || scheduleSaving}
              onChange={(e) =>
                setSchedule((current) =>
                  current ? { ...current, agent_batch: Number(e.target.value) } : current,
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={!schedule || scheduleSaving}
            onClick={() => void saveSchedule()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {scheduleSaving ? "保存中…" : "保存定时配置"}
          </button>
          {scheduleMessage ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{scheduleMessage}</p> : null}
        </div>
      </div>

      {result ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {result.dry_run ? "预览" : "已执行"}：{result.doc_count} 篇文档，{result.nodes.length} 个节点
            {result.eligible_domains.length
              ? `。允许业务域：${result.eligible_domains.map((item) => kbDomainLabel(item)).join("、")}`
              : "。策略没有声明允许的业务域，缺域节点无法自动归位。"}
            {!result.dry_run ? `。已更新 ${result.updated_rows} 条缓存。` : ""}
            {result.agent_pending ? ` 另有 ${result.agent_pending} 篇待 Hermes 判断。` : ""}
            {result.agent_applied ? ` Hermes 已判断 ${result.agent_applied} 篇。` : ""}
          </p>
          {result.nodes.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">当前没有需要按这条策略治理的节点。</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
              {result.nodes.map((node) => (
                <li
                  key={`${node.from_domain}-${node.from_folder}-${node.to_domain}-${node.to_folder}`}
                  className="py-3 text-sm"
                >
                  <p className="font-medium text-slate-900 dark:text-white">
                    {kbDomainLabel(node.from_domain)} / {node.from_folder}
                    <span className="mx-2 text-slate-400">→</span>
                    {kbDomainLabel(node.to_domain)} / {node.to_folder}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {node.doc_count} 篇 · {node.reasons.join("、")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
