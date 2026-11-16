"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type ImportScope = "internal" | "external";

type WikiSourceId = "geelywiki" | "autocar";

type WikiMcpConfig = {
  url: string;
  url_source: string;
  root?: string;
  root_source?: string;
  writable: boolean;
  config_exists: boolean;
  import_scope?: ImportScope;
  import_scope_source?: string;
};

type ProbeResult = {
  ok: boolean;
  message?: string;
  count?: number;
  latency_ms?: number;
};

type SyncReport = {
  ok?: boolean;
  error?: string;
  page_count?: number;
  doc_count?: number;
  claim_docs?: number;
  data_source?: string;
  source?: string;
  build_id?: string;
  collection?: string;
  import_scope?: ImportScope;
  graph_error?: string;
  graph_skipped?: boolean;
  cache_synced?: number;
  cache_failed?: number;
  cache_error?: string;
};

type WikiSourceSpec = {
  id: WikiSourceId;
  title: string;
  summary: string;
  configPath: string;
  syncPath: string;
  defaultScope: ImportScope;
  collections: Record<ImportScope, { label: string; collection: string }>;
};

const SOURCES: WikiSourceSpec[] = [
  {
    id: "geelywiki",
    title: "GeelyWiki",
    summary: "内部技术 Wiki。默认写入内部知识库，冲突时优先采纳。",
    configPath: "/system/wiki-mcp",
    syncPath: "/kb/geelywiki/sync",
    defaultScope: "internal",
    collections: {
      internal: { label: "内部知识库", collection: "internal.geelywiki.pages" },
      external: { label: "外部知识库", collection: "public.geelywiki.pages" },
    },
  },
  {
    id: "autocar",
    title: "Autocar Wiki",
    summary: "对外技术发布 Wiki。默认写入外部知识库，不并入内部图谱。",
    configPath: "/system/autocar-mcp",
    syncPath: "/kb/autocar/sync",
    defaultScope: "external",
    collections: {
      internal: { label: "内部知识库", collection: "internal.autocar.pages" },
      external: { label: "外部知识库", collection: "public.autocar.pages" },
    },
  },
];

function sourceLabel(source: string): string {
  if (source === "saved") return "页面保存";
  if (source === "env") return "环境变量";
  return "默认";
}

function WikiSourceCard({ spec, onSynced }: { spec: WikiSourceSpec; onSynced?: () => void }) {
  const [config, setConfig] = useState<WikiMcpConfig | null>(null);
  const [url, setUrl] = useState("");
  const [root, setRoot] = useState("");
  const [importScope, setImportScope] = useState<ImportScope>(spec.defaultScope);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await apiGet<WikiMcpConfig>(spec.configPath);
      setConfig(payload);
      setUrl(payload.url);
      setRoot(payload.root || "");
      setImportScope(payload.import_scope === "external" || payload.import_scope === "internal"
        ? payload.import_scope
        : spec.defaultScope);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "加载 MCP 配置失败");
    } finally {
      setLoading(false);
    }
  }, [spec.configPath, spec.defaultScope]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = await apiPut<WikiMcpConfig>(spec.configPath, {
        url,
        root,
        import_scope: importScope,
      });
      setConfig(payload);
      setUrl(payload.url);
      setRoot(payload.root || "");
      setImportScope(payload.import_scope === "external" ? "external" : payload.import_scope === "internal" ? "internal" : spec.defaultScope);
      setNotice("地址、目录和导入范围已保存。之后以这里的记录为准。");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    setError("");
    try {
      setProbe(await apiPost<ProbeResult>(`${spec.configPath}/probe`, { url }));
    } catch (err: unknown) {
      setProbe({ ok: false, message: err instanceof Error ? err.message : "探测失败" });
    } finally {
      setProbing(false);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setError("");
    setNotice("");
    setReport(null);
    try {
      const payload = await apiPost<SyncReport>(spec.syncPath, {
        demo: false,
        import_scope: importScope,
      });
      setReport(payload);
      if (payload.ok) {
        const target = spec.collections[payload.import_scope === "internal" ? "internal" : importScope];
        setNotice(`已从 ${spec.title} 同步到${target.label}。`);
        onSynced?.();
      } else {
        setError(payload.error || "同步未完成");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const scope = importScope === "internal" ? "internal" : "external";

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 p-5 dark:border-slate-800">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{spec.title}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{spec.summary}</p>
      </div>
      {loading ? <p className="text-sm text-slate-500">加载中…</p> : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p> : null}
      {config ? (
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="text-slate-700 dark:text-slate-200">仓库目录</span>
            <span className="ml-2 text-xs text-slate-500">{sourceLabel(config.root_source || "default")}</span>
            <input
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-700 dark:text-slate-200">导入到</span>
            <span className="ml-2 text-xs text-slate-500">
              {sourceLabel(config.import_scope_source || "default")}
              {` · ${spec.collections[scope].collection}`}
            </span>
            <select
              value={scope}
              onChange={(event) => setImportScope(event.target.value === "external" ? "external" : "internal")}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              <option value="internal">内部知识库</option>
              <option value="external">外部知识库</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-700 dark:text-slate-200">MCP 地址</span>
            <span className="ml-2 text-xs text-slate-500">
              {sourceLabel(config.url_source)}
              {!config.config_exists ? " · 尚未保存" : ""}
            </span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          {!config.writable ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">当前环境不能写入配置，只能查看和同步。</p>
          ) : null}
          {probe ? (
            <p className={`text-sm ${probe.ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`}>
              探测：{probe.message}
              {typeof probe.count === "number" ? ` · ${probe.count} 页` : ""}
              {typeof probe.latency_ms === "number" ? ` · ${probe.latency_ms}ms` : ""}
            </p>
          ) : null}
          {report?.ok ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              本次写入 {report.page_count ?? 0} 页、{report.doc_count ?? 0} 篇文档
              {typeof report.claim_docs === "number" ? `（含 ${report.claim_docs} 条主张）` : ""}
              {report.collection ? ` · ${report.collection}` : ""}
              {typeof report.cache_synced === "number" ? ` · 浏览缓存 ${report.cache_synced} 条` : ""}
              {report.graph_skipped ? " · 不并入内部图谱" : ""}
              {report.data_source ? ` · 来源 ${report.data_source}` : ""}
              {report.build_id ? ` · ${report.build_id}` : ""}
              {report.graph_error ? ` · 图谱未更新：${report.graph_error}` : ""}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={probing || syncing}
              onClick={() => void runProbe()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
            >
              {probing ? "探测中…" : "检测连接"}
            </button>
            <button
              type="button"
              disabled={!config.writable || saving || syncing}
              onClick={() => void save()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              disabled={syncing || !url.trim()}
              onClick={() => void syncNow()}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function KnowledgeMcpAccess({ onSynced }: { onSynced?: () => void }) {
  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-6 text-slate-500">
        通过 MCP 读取 Wiki 页面。不会自动轮询，点「立即同步」才拉取。仓库目录标明页面来源，同步仍走已保存的 MCP 地址。
      </p>
      {SOURCES.map((spec) => (
        <WikiSourceCard key={spec.id} spec={spec} onSynced={onSynced} />
      ))}
    </div>
  );
}
