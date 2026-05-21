"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";

type McpToolGroup = "knowledge" | "workshop" | "project" | "web";

interface ToolCatalogItem {
  name: string;
  group: McpToolGroup | string;
  title: string;
  description: string;
}

interface McpServer {
  name: string;
  enabled: boolean;
  transport: string;
  url: string;
  timeout?: number;
  connect_timeout?: number;
  tools: {
    catalog: string[];
    enabled: string[];
    include: string[] | null;
    exclude: string[];
  };
}

interface McpServersResponse {
  config_path: string;
  config_exists: boolean;
  writable: boolean;
  servers: McpServer[];
  tool_catalog: ToolCatalogItem[];
  tool_groups: Record<string, string>;
  tavily_mounted: boolean;
}

interface ProbeResult {
  ok: boolean;
  reachable?: boolean;
  status_code?: number;
  latency_ms?: number;
  message?: string;
}

const GROUP_ORDER = ["knowledge", "workshop", "project", "web"];

function groupLabel(groups: Record<string, string>, key: string): string {
  return groups[key] ?? key;
}

export default function McpManagementPanel() {
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeMap, setProbeMap] = useState<Record<string, ProbeResult>>({});
  const [draftTools, setDraftTools] = useState<Record<string, string[]>>({});

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    window.setTimeout(() => setActionMsg(""), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/mcp/servers");
      const body = await readJson<McpServersResponse>(res);
      setData(body);
      const nextDraft: Record<string, string[]> = {};
      for (const server of body.servers) {
        nextDraft[server.name] = [...server.tools.enabled];
      }
      setDraftTools(nextDraft);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载 MCP 配置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const catalogByName = useMemo(() => {
    const map = new Map<string, ToolCatalogItem>();
    for (const item of data?.tool_catalog ?? []) {
      map.set(item.name, item);
    }
    return map;
  }, [data?.tool_catalog]);

  const toggleEnabled = async (server: McpServer) => {
    setSaving(server.name);
    try {
      const res = await apiFetch(`/mcp/servers/${encodeURIComponent(server.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      await readJson(res);
      await load();
      showMsg(`${server.name} 已${server.enabled ? "禁用" : "启用"}`);
    } catch (e: unknown) {
      showMsg(`操作失败: ${e instanceof Error ? e.message : ""}`);
    } finally {
      setSaving(null);
    }
  };

  const saveTools = async (server: McpServer) => {
    setSaving(server.name);
    try {
      const res = await apiFetch(`/mcp/servers/${encodeURIComponent(server.name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tools_include: draftTools[server.name] ?? [] }),
      });
      await readJson(res);
      await load();
      showMsg(`${server.name} 工具白名单已保存`);
    } catch (e: unknown) {
      showMsg(`保存失败: ${e instanceof Error ? e.message : ""}`);
    } finally {
      setSaving(null);
    }
  };

  const runProbe = async (server: McpServer) => {
    setProbing(server.name);
    try {
      const res = await apiFetch(`/mcp/servers/${encodeURIComponent(server.name)}/probe`, {
        method: "POST",
      });
      const body = await readJson<ProbeResult & { name: string }>(res);
      setProbeMap((prev) => ({ ...prev, [server.name]: body }));
    } catch (e: unknown) {
      setProbeMap((prev) => ({
        ...prev,
        [server.name]: { ok: false, message: e instanceof Error ? e.message : "探测失败" },
      }));
    } finally {
      setProbing(null);
    }
  };

  const toggleTool = (serverName: string, toolName: string) => {
    setDraftTools((prev) => {
      const current = new Set(prev[serverName] ?? []);
      if (current.has(toolName)) current.delete(toolName);
      else current.add(toolName);
      return { ...prev, [serverName]: [...current] };
    });
  };

  const selectAllTools = (server: McpServer) => {
    setDraftTools((prev) => ({ ...prev, [server.name]: [...server.tools.catalog] }));
  };

  const renderToolGroups = (server: McpServer) => {
    const selected = new Set(draftTools[server.name] ?? []);
    const grouped = new Map<string, string[]>();
    for (const toolName of server.tools.catalog) {
      const meta = catalogByName.get(toolName);
      const group = meta?.group ?? "other";
      grouped.set(group, [...(grouped.get(group) ?? []), toolName]);
    }
    const groups = [...grouped.keys()].sort(
      (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
    );

    return (
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
              {groupLabel(data?.tool_groups ?? {}, group)}
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {(grouped.get(group) ?? []).map((toolName) => {
                const meta = catalogByName.get(toolName);
                const checked = selected.has(toolName);
                return (
                  <label
                    key={toolName}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${
                      checked
                        ? "border-blue-500/50 bg-blue-500/10"
                        : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-slate-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      onChange={() => toggleTool(server.name, toolName)}
                    />
                    <span>
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {meta?.title ?? toolName}
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">{meta?.description ?? toolName}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
        >
          刷新
        </button>
      </div>

      {loading && <p className="text-sm text-slate-500">加载中…</p>}
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      {actionMsg && <p className="mt-4 text-sm text-emerald-600 dark:text-emerald-400">{actionMsg}</p>}

      {data && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400">
            <p>
              配置文件：<span className="text-slate-800 dark:text-slate-200">{data.config_path}</span>
              {!data.config_exists && "（未找到）"}
            </p>
            <p className="mt-1">
              Tavily 代理：
              {data.tavily_mounted ? (
                <span className="text-emerald-600 dark:text-emerald-400">已配置 API Key，经 tphermes-mcp 挂载</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">未配置 TAVILY_API_KEY，联网工具不可用</span>
              )}
            </p>
            {!data.writable && (
              <p className="mt-1 text-amber-600 dark:text-amber-400">当前环境对配置目录不可写，只能查看不能保存。</p>
            )}
          </div>

          {data.servers.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-800">
              未配置 mcp_servers。请在 Hermes config.yaml 中添加 MCP 服务。
            </p>
          )}

          {data.servers.map((server) => {
            const probeResult = probeMap[server.name];
            const dirty =
              JSON.stringify([...(draftTools[server.name] ?? [])].sort()) !==
              JSON.stringify([...server.tools.enabled].sort());
            return (
              <article
                key={server.name}
                className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-lg font-medium text-slate-900 dark:text-white">{server.name}</h3>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          server.enabled
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-slate-200 text-slate-600 dark:bg-slate-700/60 dark:text-slate-400"
                        }`}
                      >
                        {server.enabled ? "已启用" : "已禁用"}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                        {server.transport}
                      </span>
                    </div>
                    <p className="mt-2 break-all text-sm text-slate-500">{server.url || "—"}</p>
                    {probeResult && (
                      <p className={`mt-2 text-sm ${probeResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                        探测：{probeResult.message}
                        {typeof probeResult.latency_ms === "number" ? ` · ${probeResult.latency_ms}ms` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={probing === server.name}
                      onClick={() => runProbe(server)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
                    >
                      {probing === server.name ? "探测中…" : "连通性探测"}
                    </button>
                    <button
                      type="button"
                      disabled={!data.writable || saving === server.name}
                      onClick={() => toggleEnabled(server)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
                    >
                      {server.enabled ? "禁用服务" : "启用服务"}
                    </button>
                  </div>
                </div>

                {server.name === "tphermes" && server.tools.catalog.length > 0 && (
                  <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-800">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">工具白名单</p>
                        <p className="mt-1 text-xs text-slate-500">
                          已选 {(draftTools[server.name] ?? []).length} / {server.tools.catalog.length}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => selectAllTools(server)}
                          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500"
                        >
                          全选
                        </button>
                        <button
                          type="button"
                          disabled={!data.writable || !dirty || saving === server.name}
                          onClick={() => saveTools(server)}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                          {saving === server.name ? "保存中…" : "保存工具白名单"}
                        </button>
                      </div>
                    </div>
                    {renderToolGroups(server)}
                  </div>
                )}

                {server.name !== "tphermes" && server.tools.enabled.length > 0 && (
                  <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-800">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-200">已启用工具</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {server.tools.enabled.map((tool) => (
                        <span
                          key={tool}
                          className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
