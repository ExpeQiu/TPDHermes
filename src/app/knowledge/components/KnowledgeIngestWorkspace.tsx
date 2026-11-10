"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { apiFetch, apiGet, apiPost } from "@/lib/api";
import {
  KB_COLLECTION_DISPLAY,
  isBindableKbCollection,
  isKbCollectionHidden,
  kbCollectionScope,
} from "@/lib/kb-collection-catalog";
import { KB_DOMAIN_LABELS, kbCollectionLabel, kbDomainLabel, kbFolderPathLabel, runStatusLabel } from "@/lib/ui-labels";

export interface KnowledgeIngestPrefill {
  collection?: string;
  domain?: string;
  folder_path?: string;
  project_id?: string;
}

const ACCEPT =
  ".md,.markdown,.txt,.text,.csv,.json,.log,.html,.htm,.pdf,.doc,.docx,.rtf,text/plain,text/markdown,text/html,application/pdf,application/msword,application/rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type QueueStatus = "uploading" | "ready" | "importing" | "done" | "error";

interface QueueItem {
  localId: string;
  name: string;
  status: QueueStatus;
  uploadId?: string;
  sourceFormat?: string;
  charCount?: number;
  error?: string;
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  uploading: "处理中",
  ready: "待导入",
  importing: "导入中",
  done: "已导入",
  error: "失败",
};

type ImportScope = "internal" | "external";

function importScopeOf(name: string): ImportScope | null {
  const scope = kbCollectionScope(name);
  if (scope === "internal") return "internal";
  if (scope === "public") return "external";
  return null;
}

function collectionOptions(live: string[], selected: string): { scope: ImportScope; name: string }[] {
  const names = new Set<string>([
    ...Object.keys(KB_COLLECTION_DISPLAY),
    ...live.filter((name) => isBindableKbCollection(name)),
  ]);
  if (selected && !isKbCollectionHidden(selected)) names.add(selected);
  const rank: Record<ImportScope, number> = { internal: 0, external: 1 };
  return [...names]
    .map((name) => ({ name, scope: importScopeOf(name) }))
    .filter((row): row is { scope: ImportScope; name: string } => row.scope != null)
    .sort((a, b) => rank[a.scope] - rank[b.scope] || kbCollectionLabel(a.name).localeCompare(kbCollectionLabel(b.name), "zh"));
}

const BASE_FOLDERS = ["02-知识库/导入", "02-知识库/待分类", "02-知识库/对话收割", "02-知识库/手动录入"];

function domainChoices(selected: string): { value: string; label: string }[] {
  const rows = Object.entries(KB_DOMAIN_LABELS)
    .filter(([key]) => key !== "_uncategorized")
    .map(([value, label]) => ({ value, label }));
  if (selected && !rows.some((row) => row.value === selected)) {
    rows.unshift({ value: selected, label: kbDomainLabel(selected) });
  }
  return rows;
}

function folderChoices(selected: string): string[] {
  const domainFolders = Object.entries(KB_DOMAIN_LABELS)
    .filter(([key]) => key !== "_uncategorized")
    .map(([, label]) => `02-知识库/${label}`);
  const names = [...BASE_FOLDERS, ...domainFolders];
  if (selected && !names.includes(selected)) names.unshift(selected);
  return names;
}

function uploadErrorMessage(data: { detail?: unknown }, status: number): string {
  if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
  return `上传失败 HTTP ${status}`;
}

export default function KnowledgeIngestWorkspace({
  useMock,
  prefill,
  prefillNonce,
  onCompleted,
}: {
  useMock: boolean;
  prefill: KnowledgeIngestPrefill;
  prefillNonce: number;
  onCompleted?: () => void;
}) {
  const [collection, setCollection] = useState(prefill.collection || "");
  const [liveCollections, setLiveCollections] = useState<string[]>([]);
  const [domain, setDomain] = useState(prefill.domain || "structured_tech");
  const [folderPath, setFolderPath] = useState(prefill.folder_path || "02-知识库/导入");
  const [projectId, setProjectId] = useState(prefill.project_id || "__all__");
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobView, setJobView] = useState<Record<string, unknown> | null>(null);
  const [docIdOnUpload, setDocIdOnUpload] = useState("");
  const [uploadDocIdsJson, setUploadDocIdsJson] = useState("");
  const [docIdStrategy, setDocIdStrategy] = useState<"filename" | "checksum">("filename");
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const notifiedJobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ collections?: string[] }>("/kb/collections?prefer_cache=1")
      .then((payload) => {
        if (!cancelled) setLiveCollections(payload.collections ?? []);
      })
      .catch((err: unknown) => {
        console.warn("[kb-ingest] 合集列表加载失败", err instanceof Error ? err.message : err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCollection(prefill.collection || "");
    setDomain(prefill.domain || "structured_tech");
    setFolderPath(prefill.folder_path || "02-知识库/导入");
    setProjectId(prefill.project_id || "__all__");
  }, [prefill, prefillNonce]);

  const options = useMemo(
    () => collectionOptions(liveCollections, collection),
    [liveCollections, collection],
  );
  const internalOptions = options.filter((row) => row.scope === "internal");
  const externalOptions = options.filter((row) => row.scope === "external");

  const readyIds = useMemo(
    () => queue.filter((item) => item.status === "ready" && item.uploadId).map((item) => item.uploadId as string),
    [queue],
  );

  const patchQueue = (localId: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...patch } : item)));
  };

  const markIds = (ids: string[], status: QueueStatus, error?: string) => {
    const idSet = new Set(ids);
    setQueue((prev) =>
      prev.map((item) =>
        item.uploadId && idSet.has(item.uploadId) ? { ...item, status, error } : item,
      ),
    );
  };

  const uploadFiles = async (files: File[], autoImport: boolean) => {
    if (!files.length) return;
    setMessage(null);
    setBusy(true);
    const created: QueueItem[] = files.map((file, index) => ({
      localId: `${Date.now()}-${index}-${file.name}`,
      name: file.name,
      status: "uploading",
    }));
    setQueue((prev) => [...created, ...prev]);
    const ids: string[] = [];
    let failed = 0;
    const hint = docIdOnUpload.trim();
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const localId = created[i].localId;
        const fd = new FormData();
        fd.append("file", file);
        if (hint && files.length === 1) fd.append("doc_id", hint);
        try {
          const res = await apiFetch("/kb/upload", { method: "POST", body: fd });
          const data = (await res.json()) as {
            upload_id?: string;
            detail?: unknown;
            source_format?: string;
            char_count?: number;
          };
          if (!res.ok || !data.upload_id) {
            failed += 1;
            patchQueue(localId, { status: "error", error: uploadErrorMessage(data, res.status) });
            continue;
          }
          ids.push(data.upload_id);
          patchQueue(localId, {
            status: "ready",
            uploadId: data.upload_id,
            sourceFormat: data.source_format,
            charCount: data.char_count,
          });
        } catch (e) {
          failed += 1;
          patchQueue(localId, { status: "error", error: e instanceof Error ? e.message : "上传失败" });
        }
      }
      if (ids.length) setUploadIds((prev) => [...prev, ...ids]);
      const summary = `已处理 ${ids.length} 个文件${failed ? `，失败 ${failed} 个` : ""}`;
      if (hint && files.length > 1) {
        setMessage(`${summary}。多个文件时忽略统一文档 ID，按所选策略生成。`);
      } else {
        setMessage(summary);
      }
      if (autoImport && ids.length) {
        await runIngest(ids);
      } else if (autoImport && !ids.length) {
        setMessage("没有可导入的文件");
      }
    } finally {
      setBusy(false);
    }
  };

  const runIngest = async (explicitIds?: string[]) => {
    const target = explicitIds?.length ? explicitIds : readyIds;
    if (!collection.trim()) {
      setMessage("请选择知识集合");
      return;
    }
    if (!target.length) {
      setMessage("请先上传文件");
      return;
    }
    setBusy(true);
    setMessage(null);
    markIds(target, "importing");
    try {
      let upload_doc_ids: Record<string, string> | undefined;
      const mapRaw = uploadDocIdsJson.trim();
      if (mapRaw) {
        try {
          upload_doc_ids = JSON.parse(mapRaw) as Record<string, string>;
          if (!upload_doc_ids || typeof upload_doc_ids !== "object" || Array.isArray(upload_doc_ids)) {
            throw new Error("需为对象");
          }
        } catch {
          markIds(target, "ready");
          setMessage("上传 ID 映射须为「上传 ID → 文档 ID」的 JSON 对象");
          setBusy(false);
          return;
        }
      }

      console.info("[kb-ingest] 开始导入", {
        collection: collection.trim(),
        domain: domain.trim(),
        folder_path: folderPath.trim(),
        files: target.length,
      });
      const body: Record<string, unknown> = {
        source_type: "upload",
        collection: collection.trim(),
        project_id: projectId.trim() || "__all__",
        sync_cache: true,
        upload_ids: target,
        defaults: {
          domain: domain.trim(),
          folder_path: folderPath.trim(),
          published: true,
          source: "manual_import",
          source_type: "file",
          language: "zh",
          doc_id_strategy: docIdStrategy,
        },
      };
      if (upload_doc_ids) body.upload_doc_ids = upload_doc_ids;
      const report = await apiPost<Record<string, unknown>>("/kb/ingest", body);
      const nextJobId = typeof report.job_id === "string" ? report.job_id : null;
      setJobId(nextJobId);
      setJobView(report);
      setMessage(
        typeof report.status === "string" ? `任务状态：${runStatusLabel(report.status)}` : "导入任务已创建",
      );
    } catch (e) {
      markIds(target, "ready");
      setMessage(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const applyJob = (row: { status: string; result: Record<string, unknown> | null }) => {
    setJobView(row.result ?? { status: row.status });
    setMessage(`任务 ${jobId}：${runStatusLabel(row.status)}`);
    if (row.status === "completed") {
      setQueue((prev) => prev.map((item) => (item.status === "importing" ? { ...item, status: "done" } : item)));
      if (jobId && notifiedJobRef.current !== jobId) {
        notifiedJobRef.current = jobId;
        onCompleted?.();
      }
    } else if (row.status === "failed") {
      setQueue((prev) =>
        prev.map((item) =>
          item.status === "importing" ? { ...item, status: "error", error: "导入失败" } : item,
        ),
      );
    }
  };

  const pollJob = async () => {
    if (!jobId) return;
    try {
      const row = await apiGet<{
        status: string;
        result: Record<string, unknown> | null;
      }>(`/kb/ingest-jobs/${encodeURIComponent(jobId)}`);
      applyJob(row);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "查询任务失败");
    }
  };

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const row = await apiGet<{
          status: string;
          result: Record<string, unknown> | null;
        }>(`/kb/ingest-jobs/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        applyJob(row);
        if (row.status === "completed" || row.status === "failed") {
          window.clearInterval(timer);
        }
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : "查询任务失败");
      }
    };
    const timer = window.setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // 任务创建后轮询到终态；applyJob 读取当前 jobId。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const clearQueue = () => {
    setUploadIds([]);
    setQueue([]);
    setJobId(null);
    setJobView(null);
    setMessage(null);
    setUploadDocIdsJson("");
  };

  const onPick = (fileList: FileList | null, autoImport: boolean) => {
    const files = fileList ? Array.from(fileList) : [];
    if (uploadInputRef.current) uploadInputRef.current.value = "";
    if (batchInputRef.current) batchInputRef.current.value = "";
    void uploadFiles(files, autoImport);
  };

  if (useMock) {
    return (
      <p className="text-slate-500 text-sm text-center py-12">
        Mock 模式下请关闭 `NEXT_PUBLIC_USE_MOCK_KB` 以使用上传与导入。
      </p>
    );
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-6">
        <p className="text-sm text-slate-400">
          文档会先抽成文本，再异步写入外部 Chroma 并增量回填 kb_cache。目录树和条目详情可把域、目录、集合预填到此工作台。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-slate-400">知识集合</span>
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">请选择知识集合</option>
              {collection && !options.some((row) => row.name === collection) ? (
                <option value={collection}>{kbCollectionLabel(collection)}</option>
              ) : null}
              <optgroup label="内部知识库">
                {internalOptions.map((row) => (
                  <option key={row.name} value={row.name}>
                    {kbCollectionLabel(row.name)}
                  </option>
                ))}
              </optgroup>
              <optgroup label="外部知识库">
                {externalOptions.map((row) => (
                  <option key={row.name} value={row.name}>
                    {kbCollectionLabel(row.name)}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">业务域</span>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              {domainChoices(domain).map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">目录路径</span>
            <select
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              {folderChoices(folderPath).map((path) => (
                <option key={path} value={path}>
                  {kbFolderPathLabel(path)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">缓存同步项目 ID</span>
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">上传时文档 ID（可选）</span>
            <input
              value={docIdOnUpload}
              onChange={(e) => setDocIdOnUpload(e.target.value)}
              placeholder="仅单个文件时生效"
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">默认 doc_id 策略</span>
            <select
              value={docIdStrategy}
              onChange={(e) => setDocIdStrategy(e.target.value === "checksum" ? "checksum" : "filename")}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="filename">原文件名 stem</option>
              <option value="checksum">sha256 前缀</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">上传 ID → 文档 ID 映射（JSON，可选）</span>
            <input
              value={uploadDocIdsJson}
              onChange={(e) => setUploadDocIdsJson(e.target.value)}
              placeholder='{"uuid-1":"my_doc_a"}'
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm font-mono"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !readyIds.length}
            onClick={() => void runIngest()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            开始导入
          </button>
          <button
            type="button"
            disabled={!jobId}
            onClick={() => void pollJob()}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-800 dark:text-slate-200 disabled:opacity-40"
          >
            刷新任务状态
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={clearQueue}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-800 dark:text-slate-200"
          >
            清空队列
          </button>
        </div>
        {uploadIds.length ? (
          <p className="text-xs text-slate-500">队列中上传 ID：{uploadIds.join(", ")}</p>
        ) : null}
        {message ? <p className="text-sm whitespace-pre-wrap text-amber-500">{message}</p> : null}
        {jobView ? (
          <pre className="text-xs bg-slate-100 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-lg p-3 overflow-auto max-h-64 text-slate-700 dark:text-slate-300">
            {JSON.stringify(jobView, null, 2)}
          </pre>
        ) : null}
      </div>

      <aside className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-950/40">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">文件导入</h2>
          <span className="text-xs text-slate-500">{queue.length ? `${queue.length} 个` : "空队列"}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          支持 md、txt、doc、docx、pdf、html、rtf。上传后自动抽取正文；批量导入会接着写入当前知识集合。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => uploadInputRef.current?.click()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          >
            上传文件
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => batchInputRef.current?.click()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
          >
            批量导入
          </button>
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => onPick(e.target.files, false)}
        />
        <input
          ref={batchInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => onPick(e.target.files, true)}
        />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onPick(e.dataTransfer.files, false);
          }}
          className={`mt-3 rounded-xl border border-dashed px-3 py-6 text-center text-xs ${
            dragOver
              ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
              : "border-slate-300 text-slate-500 dark:border-slate-600"
          }`}
        >
          拖入文件到此窗口，先抽取再等待导入
        </div>
        <ul className="mt-3 max-h-[28rem] space-y-2 overflow-auto">
          {queue.length === 0 ? (
            <li className="rounded-lg border border-slate-200 px-3 py-4 text-center text-xs text-slate-400 dark:border-slate-800">
              还没有文件
            </li>
          ) : (
            queue.map((item) => (
              <li
                key={item.localId}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm text-slate-800 dark:text-slate-100" title={item.name}>
                    {item.name}
                  </p>
                  <span className="shrink-0 text-xs text-slate-500">{STATUS_LABEL[item.status]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {item.sourceFormat ? item.sourceFormat.toUpperCase() : "—"}
                  {typeof item.charCount === "number" ? ` · ${item.charCount} 字` : ""}
                </p>
                {item.error ? <p className="mt-1 text-xs text-amber-600">{item.error}</p> : null}
              </li>
            ))
          )}
        </ul>
      </aside>
    </div>
  );
}
