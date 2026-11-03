"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { kbCollectionScope, kbCollectionScopeLabel } from "@/lib/kb-collection-catalog";
import { kbCollectionLabel } from "@/lib/ui-labels";

type CatalogDomain = {
  key: string;
  label: string;
  builtin: boolean;
  doc_count: number;
  collection_count: number;
};

type CatalogFolder = {
  path: string;
  label: string;
  domain: string;
  scope: string;
  doc_count: number;
  stored: boolean;
};

type CatalogResponse = {
  domains: CatalogDomain[];
  folders: CatalogFolder[];
};

type CollectionItem = { name: string; entry_count: number };
type ProjectItem = { id: string; name: string };

const SCOPE_OPTIONS = [
  { key: "internal", label: "内部知识库" },
  { key: "public", label: "公共知识库" },
  { key: "project", label: "项目知识库" },
] as const;

const CATALOG_ERRORS: Record<string, string> = {
  invalid_domain_key: "业务域标识需使用小写英文、数字或下划线。",
  domain_exists: "这个业务域已经存在。",
  builtin_domain: "内置业务域不能删除，可以修改显示名。",
  domain_in_use: "业务域下还有目录或文档，不能删除。",
  domain_not_found: "没有找到这个业务域。",
  domain_required: "请选择业务域。",
  invalid_folder_path: "目录路径无效。",
  folder_not_empty: "目录下还有正式文档，请先移走或删除这些文档。",
  folder_delete_failed: "目录索引没有全部删掉，请再试一次。",
  scope_required: "请选择知识库。",
  project_required: "请选择项目。",
  label_required: "请填写显示名。",
};

function catalogError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return CATALOG_ERRORS[raw] || raw || fallback;
}

const fieldClass =
  "mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";

export default function KnowledgeCatalogPanel({
  collections,
  projects,
  projectNames,
  busy,
  onDeleteCollection,
  onReload,
}: {
  collections: CollectionItem[];
  projects: ProjectItem[];
  projectNames: Record<string, string>;
  busy: boolean;
  onDeleteCollection: (name: string, label: string, count: number) => void;
  onReload: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogResponse>({ domains: [], folders: [] });
  const [scope, setScope] = useState<(typeof SCOPE_OPTIONS)[number]["key"]>("public");
  const [projectId, setProjectId] = useState("");
  const [domain, setDomain] = useState("structured_tech");
  const [folderPath, setFolderPath] = useState("02-知识库");
  const [topic, setTopic] = useState("");
  const [domainKey, setDomainKey] = useState("");
  const [domainLabel, setDomainLabel] = useState("");
  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  const [editingDomainLabel, setEditingDomainLabel] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editingFolderPath, setEditingFolderPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const data = await apiGet<CatalogResponse>("/kb/catalog");
    if (seq !== loadSeq.current) return;
    setCatalog({
      domains: data.domains || [],
      folders: data.folders || [],
    });
    setDomain((current) => current || data.domains?.[0]?.key || "structured_tech");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((error) => {
      if (!cancelled) setMessage(catalogError(error, "分类目录加载失败"));
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const domainOptions = catalog.domains.length
    ? catalog.domains
    : [{ key: "structured_tech", label: "结构化技术", builtin: true, doc_count: 0, collection_count: 0 }];

  const grouped = useMemo(() => {
    return SCOPE_OPTIONS.map((item) => ({
      ...item,
      collections: collections.filter((col) => kbCollectionScope(col.name) === item.key),
    }));
  }, [collections]);

  const run = async (work: () => Promise<void>) => {
    setLocalBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
      onReload();
    } catch (error) {
      setMessage(catalogError(error, "操作失败"));
    } finally {
      setLocalBusy(false);
    }
  };

  const createCollection = () =>
    run(async () => {
      const selectedDomain = domain.trim();
      let name = "";
      if (scope === "project") {
        if (!projectId) throw new Error("project_required");
        name = `project.${projectId}.kb`;
      } else {
        const slug = topic.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "");
        if (!slug) throw new Error("请填写合集标识。");
        name = `${scope}.${selectedDomain}.${slug}`;
      }
      await apiPost("/kb/entries/manual", {
        collection: name,
        project_id: scope === "project" ? projectId : "__all__",
        title: `合集分类索引 · ${name}`,
        content: `该条目用于占位，使合集 ${name} 出现在对应知识库和业务域下。`,
        domain: selectedDomain,
        folder_path: folderPath.trim() || "02-知识库",
        published: true,
        doc_id: `colcat_${scope === "project" ? projectId : topic.trim()}`,
        sync_cache: true,
        source_type: "catalog_index",
      });
      setTopic("");
      setMessage(`已新建合集：${name}`);
    });

  const createFolder = () =>
    run(async () => {
      await apiPost("/kb/catalog/folders", {
        path: folderPath,
        domain,
        scope,
        project_id: projectId,
      });
      setMessage(`已新建目录：${folderPath.trim()}`);
    });

  const disabled = busy || localBusy;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
        <p className="text-sm font-medium text-slate-900 dark:text-white">分类落点</p>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          用知识库、业务域和目录路径新建合集或目录。下面三栏可以查看、修改和删除已有项。
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="block text-xs">
            <span className="text-slate-500">知识库</span>
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={fieldClass}>
              {SCOPE_OPTIONS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-slate-500">业务域</span>
            <select value={domain} onChange={(e) => setDomain(e.target.value)} className={fieldClass}>
              {domainOptions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="text-slate-500">目录路径</span>
            <input
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="如 02-知识库/子目录"
              className={`${fieldClass} font-mono`}
            />
          </label>
        </div>
        {scope === "project" ? (
          <label className="mt-3 block max-w-md text-xs">
            <span className="text-slate-500">项目</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={fieldClass}>
              <option value="">选择项目…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="mt-3 block max-w-md text-xs">
            <span className="text-slate-500">合集标识</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="如 tech_notes"
              className={`${fieldClass} font-mono`}
            />
          </label>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void createCollection()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            新建合集
          </button>
          <button
            type="button"
            disabled={disabled || !folderPath.trim()}
            onClick={() => void createFolder()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200"
          >
            新建目录
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-sm font-medium text-slate-900 dark:text-white">知识库</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">内部、公共、项目三类固定。可查看并删除其中的合集。</p>
          <div className="mt-3 space-y-3">
            {grouped.map((item) => (
              <div key={item.key}>
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
                  {item.label}
                  <span className="ml-1 text-slate-400">({item.collections.length})</span>
                </p>
                <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
                  {item.collections.length ? (
                    item.collections.map((col) => (
                      <li key={col.name} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate" title={col.name}>
                          {kbCollectionLabel(col.name, { projectNames })}
                        </span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            onDeleteCollection(
                              col.name,
                              kbCollectionLabel(col.name, { projectNames }),
                              col.entry_count,
                            )
                          }
                          className="shrink-0 text-rose-700 hover:underline disabled:opacity-40 dark:text-rose-300"
                        >
                          删除
                        </button>
                      </li>
                    ))
                  ) : (
                    <li className="text-xs text-slate-400">暂无合集</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-sm font-medium text-slate-900 dark:text-white">业务域</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">可新建自定义业务域，修改显示名，删除未被使用的自定义域。</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input
              value={domainKey}
              onChange={(e) => setDomainKey(e.target.value)}
              placeholder="标识，如 lab_notes"
              className={`${fieldClass} font-mono`}
            />
            <input
              value={domainLabel}
              onChange={(e) => setDomainLabel(e.target.value)}
              placeholder="显示名"
              className={fieldClass}
            />
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                await apiPost("/kb/catalog/domains", { key: domainKey.trim(), label: domainLabel.trim() });
                setDomainKey("");
                setDomainLabel("");
                setMessage("已新建业务域");
              })
            }
            className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-800 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200"
          >
            新建业务域
          </button>
          <ul className="mt-3 max-h-64 space-y-2 overflow-auto">
            {domainOptions.map((item) => (
              <li key={item.key} className="rounded-lg border border-slate-200 px-2 py-2 text-xs dark:border-slate-700">
                {editingDomain === item.key ? (
                  <div className="flex gap-2">
                    <input
                      value={editingDomainLabel}
                      onChange={(e) => setEditingDomainLabel(e.target.value)}
                      className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 dark:border-slate-600 dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        void run(async () => {
                          await apiPatch(`/kb/catalog/domains/${encodeURIComponent(item.key)}`, {
                            label: editingDomainLabel.trim(),
                          });
                          setEditingDomain(null);
                          setMessage("已修改业务域显示名");
                        })
                      }
                      className="text-slate-800 hover:underline dark:text-slate-100"
                    >
                      保存
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-slate-800 dark:text-slate-100">{item.label}</p>
                      <p className="font-mono text-[11px] text-slate-400">
                        {item.key} · {item.doc_count} 条 · {item.collection_count} 个合集
                        {item.builtin ? " · 内置" : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingDomain(item.key);
                          setEditingDomainLabel(item.label);
                        }}
                        className="text-slate-600 hover:underline dark:text-slate-300"
                      >
                        修改
                      </button>
                      <button
                        type="button"
                        disabled={disabled || item.builtin}
                        onClick={() => {
                          if (!window.confirm(`删除业务域「${item.label}」？`)) return;
                          void run(async () => {
                            await apiDelete(`/kb/catalog/domains/${encodeURIComponent(item.key)}`);
                            setMessage("已删除业务域");
                          });
                        }}
                        className="text-rose-700 hover:underline disabled:opacity-40 dark:text-rose-300"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-sm font-medium text-slate-900 dark:text-white">目录路径</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">修改会改写该路径下的文档。有正式文档时不能删除。</p>
          <ul className="mt-3 max-h-80 space-y-2 overflow-auto">
            {catalog.folders.length ? (
              catalog.folders.map((item) => (
                <li key={item.path} className="rounded-lg border border-slate-200 px-2 py-2 text-xs dark:border-slate-700">
                  {editingFolder === item.path ? (
                    <div className="flex gap-2">
                      <input
                        value={editingFolderPath}
                        onChange={(e) => setEditingFolderPath(e.target.value)}
                        className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 font-mono dark:border-slate-600 dark:bg-slate-950"
                      />
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          void run(async () => {
                            await apiPatch("/kb/catalog/folders", {
                              path: item.path,
                              new_path: editingFolderPath.trim(),
                            });
                            setEditingFolder(null);
                            setMessage("已修改目录路径");
                          })
                        }
                        className="text-slate-800 hover:underline dark:text-slate-100"
                      >
                        保存
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-slate-800 dark:text-slate-100" title={item.path}>
                          {item.path}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {item.scope === "internal" || item.scope === "public" || item.scope === "project"
                            ? kbCollectionScopeLabel(item.scope)
                            : "未归类"}
                          {item.domain
                            ? ` · ${domainOptions.find((entry) => entry.key === item.domain)?.label || item.domain}`
                            : ""}
                          {` · ${item.doc_count} 条`}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingFolder(item.path);
                            setEditingFolderPath(item.path);
                          }}
                          className="text-slate-600 hover:underline dark:text-slate-300"
                        >
                          修改
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            if (!window.confirm(`删除目录「${item.path}」？目录下若有正式文档会取消删除。`)) return;
                            void run(async () => {
                              await apiDelete(`/kb/catalog/folders?path=${encodeURIComponent(item.path)}`);
                              setMessage("已删除目录");
                            });
                          }}
                          className="text-rose-700 hover:underline disabled:opacity-40 dark:text-rose-300"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))
            ) : (
              <li className="text-xs text-slate-400">还没有目录路径</li>
            )}
          </ul>
        </section>
      </div>
      {message ? <p className="text-xs text-amber-800 dark:text-amber-200">{message}</p> : null}
    </div>
  );
}
