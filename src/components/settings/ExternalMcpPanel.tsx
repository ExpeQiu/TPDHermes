"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type ExternalProvider = {
  id: string;
  name: string;
  site: string;
  summary: string;
  status: "reserved" | "configured" | string;
  mcp_url: string;
  mcp_url_source: "saved" | "env" | "default" | string;
};

type ExternalMcpConfig = {
  config_path: string;
  config_exists: boolean;
  writable: boolean;
  providers: ExternalProvider[];
};

type ProbeResult = {
  ok: boolean;
  reserved?: boolean;
  count?: number;
  latency_ms?: number;
  message?: string;
};

function sourceLabel(source: string): string {
  if (source === "saved") return "页面保存";
  if (source === "env") return "环境变量";
  return "未填写";
}

export default function ExternalMcpPanel() {
  const [config, setConfig] = useState<ExternalMcpConfig | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});

  const apply = useCallback((payload: ExternalMcpConfig) => {
    setConfig(payload);
    const next: Record<string, string> = {};
    for (const provider of payload.providers) next[provider.id] = provider.mcp_url;
    setUrls(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      apply(await apiGet<ExternalMcpConfig>("/system/external-mcp"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载三方 MCP 失败");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (provider: ExternalProvider) => {
    setSaving(provider.id);
    setError("");
    try {
      apply(
        await apiPut<ExternalMcpConfig>(`/system/external-mcp/${provider.id}`, {
          mcp_url: urls[provider.id] ?? "",
        }),
      );
      setActionMsg(`${provider.name} 已保存。之后以本页记录为准。`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(null);
    }
  };

  const runProbe = async (provider: ExternalProvider) => {
    setProbing(provider.id);
    try {
      const result = await apiPost<ProbeResult>(`/system/external-mcp/${provider.id}/probe`, {
        mcp_url: urls[provider.id] ?? "",
      });
      setProbes((prev) => ({ ...prev, [provider.id]: result }));
    } catch (err: unknown) {
      setProbes((prev) => ({
        ...prev,
        [provider.id]: { ok: false, message: err instanceof Error ? err.message : "探测失败" },
      }));
    } finally {
      setProbing(null);
    }
  };

  return (
    <div className="space-y-4">
      {loading && <p className="text-sm text-slate-500">加载中…</p>}
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      {actionMsg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{actionMsg}</p>}
      {config && (
        <>
          <p className="text-sm text-slate-500">
            配置文件：<span className="text-slate-800 dark:text-slate-200">{config.config_path}</span>
            {!config.config_exists && "（尚未保存）"}
          </p>
          {config.providers.map((provider) => {
            const probe = probes[provider.id];
            const reserved = !((urls[provider.id] ?? "").trim());
            return (
              <section
                key={provider.id}
                className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-medium text-slate-900 dark:text-white">{provider.name}</h2>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      reserved
                        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    }`}
                  >
                    {reserved ? "预留" : "已填地址"}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-500">{provider.summary}</p>
                <p className="mt-3 text-sm">
                  <span className="text-slate-500">站点 </span>
                  <a
                    href={provider.site}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {provider.site}
                  </a>
                </p>
                <label className="mt-4 block text-sm">
                  <span className="text-slate-700 dark:text-slate-200">MCP 地址</span>
                  <span className="ml-2 text-xs text-slate-500">{sourceLabel(provider.mcp_url_source)}</span>
                  <input
                    value={urls[provider.id] ?? ""}
                    onChange={(event) => setUrls((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    placeholder="接入时填写，例如 https://example/mcp"
                  />
                </label>
                {probe && (
                  <p
                    className={`mt-3 text-sm ${probe.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}
                  >
                    探测：{probe.message}
                    {typeof probe.latency_ms === "number" ? ` · ${probe.latency_ms}ms` : ""}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={probing === provider.id}
                    onClick={() => void runProbe(provider)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
                  >
                    {probing === provider.id ? "探测中…" : "连通性探测"}
                  </button>
                  <button
                    type="button"
                    disabled={!config.writable || saving === provider.id}
                    onClick={() => void save(provider)}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {saving === provider.id ? "保存中…" : "保存预留配置"}
                  </button>
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
