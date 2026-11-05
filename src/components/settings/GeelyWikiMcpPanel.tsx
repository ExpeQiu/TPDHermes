"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type WikiMcpConfig = {
  config_path: string;
  config_exists: boolean;
  writable: boolean;
  url: string;
  url_source: "saved" | "env" | "default" | string;
};

type ProbeResult = {
  ok: boolean;
  reachable?: boolean;
  count?: number;
  latency_ms?: number;
  message?: string;
};

function sourceLabel(source: string): string {
  if (source === "saved") return "页面保存";
  if (source === "env") return "环境变量";
  return "默认";
}

export default function GeelyWikiMcpPanel() {
  const [config, setConfig] = useState<WikiMcpConfig | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const apply = useCallback((payload: WikiMcpConfig) => {
    setConfig(payload);
    setUrl(payload.url);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      apply(await apiGet<WikiMcpConfig>("/system/wiki-mcp"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载 GeelyWiki MCP 配置失败");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      apply(await apiPut<WikiMcpConfig>("/system/wiki-mcp", { url }));
      setActionMsg("已保存。之后以本页记录为准，环境变量不再盖回。");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await apiPost<ProbeResult>("/system/wiki-mcp/probe", { url }));
    } catch (err: unknown) {
      setProbe({ ok: false, message: err instanceof Error ? err.message : "探测失败" });
    } finally {
      setProbing(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-slate-900 dark:text-white">GeelyWiki MCP</h2>
          <p className="mt-1 text-sm text-slate-500">
            通过 MCP 拉取页面更新。这一块不写入 Harness 的 MCP 服务列表。探测会调用 pages_list。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
        >
          刷新
        </button>
      </div>

      {loading && <p className="mt-4 text-sm text-slate-500">加载中…</p>}
      {error && <p className="mt-4 text-sm text-red-500 dark:text-red-400">{error}</p>}
      {actionMsg && <p className="mt-4 text-sm text-emerald-600 dark:text-emerald-400">{actionMsg}</p>}

      {config && (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-slate-500">
            配置文件：<span className="text-slate-800 dark:text-slate-200">{config.config_path}</span>
            {!config.config_exists && "（尚未保存）"}
          </p>
          {!config.writable && (
            <p className="text-sm text-amber-600 dark:text-amber-400">当前环境对配置目录不可写，只能查看不能保存。</p>
          )}

          <label className="block text-sm">
            <span className="text-slate-700 dark:text-slate-200">MCP 地址</span>
            <span className="ml-2 text-xs text-slate-500">{sourceLabel(config.url_source)}</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              placeholder="http://127.0.0.1:8787/mcp"
            />
          </label>

          {probe && (
            <p className={`text-sm ${probe.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
              探测：{probe.message}
              {typeof probe.latency_ms === "number" ? ` · ${probe.latency_ms}ms` : ""}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={probing}
              onClick={() => void runProbe()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
            >
              {probing ? "探测中…" : "连通性探测"}
            </button>
            <button
              type="button"
              disabled={!config.writable || saving}
              onClick={() => void save()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存 MCP 配置"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
