"use client";

import { useEffect, useState } from "react";

import { apiGet, apiPost } from "@/lib/api";
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
  doc_count: number;
}

interface GovernResult {
  ok: boolean;
  dry_run: boolean;
  eligible_domains: string[];
  nodes: GovernNode[];
  doc_count: number;
  updated_rows: number;
}

export default function KnowledgeAutoGovern({ onCompleted }: { onCompleted?: () => void }) {
  const [policies, setPolicies] = useState<PolicyItem[]>([]);
  const [policyId, setPolicyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GovernResult | null>(null);

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

  const run = async (dryRun: boolean) => {
    if (!policyId) return;
    setRunning(true);
    setError(null);
    try {
      const data = await apiPost<GovernResult>(
        `/kb/policies/${encodeURIComponent(policyId)}/auto-govern`,
        { dry_run: dryRun },
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
          找出未设置业务域、缺少目录，或不在策略允许范围内的节点，归到该策略的业务域和对应目录。
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
            执行自动治理
          </button>
        </div>
        {!loading && policies.length === 0 ? (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">
            先在「策略」里创建并发布一条策略，且配置 eligible_domains。
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      </div>

      {result ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {result.dry_run ? "预览" : "已执行"}：{result.doc_count} 篇文档，{result.nodes.length} 个节点
            {result.eligible_domains.length
              ? `。允许业务域：${result.eligible_domains.map((item) => kbDomainLabel(item)).join("、")}`
              : "。策略没有声明允许的业务域，缺域节点无法自动归位。"}
            {!result.dry_run ? `。已更新 ${result.updated_rows} 条缓存。` : ""}
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
