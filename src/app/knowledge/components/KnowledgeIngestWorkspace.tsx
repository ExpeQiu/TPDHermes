"use client";

import { useEffect, useMemo, useState } from "react";

import { apiFetch, apiGet, apiPost } from "@/lib/api";
import { runStatusLabel } from "@/lib/ui-labels";

export interface KnowledgeIngestPrefill {
  collection?: string;
  domain?: string;
  folder_path?: string;
  project_id?: string;
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
  const [domain, setDomain] = useState(prefill.domain || "structured_tech");
  const [folderPath, setFolderPath] = useState(prefill.folder_path || "02-知识库/导入");
  const [projectId, setProjectId] = useState(prefill.project_id || "__all__");
  const [uploadIds, setUploadIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobView, setJobView] = useState<Record<string, unknown> | null>(null);
  const [docIdOnUpload, setDocIdOnUpload] = useState("");
  const [uploadDocIdsJson, setUploadDocIdsJson] = useState("");
  const [docIdStrategy, setDocIdStrategy] = useState<"filename" | "checksum">("filename");

  useEffect(() => {
    setCollection(prefill.collection || "");
    setDomain(prefill.domain || "structured_tech");
    setFolderPath(prefill.folder_path || "02-知识库/导入");
    setProjectId(prefill.project_id || "__all__");
  }, [prefill, prefillNonce]);

  const uploadSummary = useMemo(() => {
    if (!uploadIds.length) return "";
    return uploadIds.join(", ");
  }, [uploadIds]);

  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setMessage(null);
    setBusy(true);
    const ids: string[] = [];
    try {
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const fd = new FormData();
        fd.append("file", f);
        const hint = docIdOnUpload.trim();
        if (hint) fd.append("doc_id", hint);
        const res = await apiFetch("/kb/upload", { method: "POST", body: fd });
        const data = (await res.json()) as { upload_id?: string; detail?: string };
        if (!res.ok) {
          throw new Error(typeof data.detail === "string" ? data.detail : `上传失败 HTTP ${res.status}`);
        }
        if (data.upload_id) ids.push(data.upload_id);
      }
      setUploadIds((prev) => [...prev, ...ids]);
      setMessage(`已上传 ${ids.length} 个文件`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  const runIngest = async () => {
    if (!collection.trim()) {
      setMessage("请填写 collection");
      return;
    }
    if (!uploadIds.length) {
      setMessage("请先上传文件");
      return;
    }
    setBusy(true);
    setMessage(null);
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
          setMessage("上传 ID 映射须为「上传 ID → 文档 ID」的 JSON 对象");
          setBusy(false);
          return;
        }
      }

      const body: Record<string, unknown> = {
        source_type: "upload",
        collection: collection.trim(),
        project_id: projectId.trim() || "__all__",
        sync_cache: true,
        upload_ids: uploadIds,
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
      setMessage(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  const pollJob = async () => {
    if (!jobId) return;
    try {
      const row = await apiGet<{
        status: string;
        result: Record<string, unknown> | null;
      }>(`/kb/ingest-jobs/${encodeURIComponent(jobId)}`);
      setJobView(row.result ?? { status: row.status });
      setMessage(`任务 ${jobId}：${runStatusLabel(row.status)}`);
      if (row.status === "completed") {
        onCompleted?.();
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "查询任务失败");
    }
  };

  const clearQueue = () => {
    setUploadIds([]);
    setJobId(null);
    setJobView(null);
    setMessage(null);
    setUploadDocIdsJson("");
  };

  if (useMock) {
    return (
      <p className="text-slate-500 text-sm text-center py-12">
        Mock 模式下请关闭 `NEXT_PUBLIC_USE_MOCK_KB` 以使用上传与导入。
      </p>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-sm text-slate-400">
        上传 Markdown / 纯文本，异步写入外部 Chroma 并增量回填 `kb_cache`。目录树和条目详情可把域、目录、集合预填到此工作台。
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-slate-400">知识集合</span>
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="如：public.structured_tech.topic"
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-400">业务域</span>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="text-slate-400">目录路径</span>
          <input
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
          />
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
            placeholder="稳定文档 ID，幂等更新 / publish"
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
      <div>
        <input
          type="file"
          multiple
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          disabled={busy}
          onChange={(e) => void onPickFiles(e.target.files)}
          className="block w-full text-sm text-slate-700 dark:text-slate-300"
        />
        {uploadSummary ? <p className="text-xs text-slate-500 mt-2">已选上传 ID：{uploadSummary}</p> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
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
      {message ? <p className="text-sm whitespace-pre-wrap text-amber-500">{message}</p> : null}
      {jobView ? (
        <pre className="text-xs bg-slate-100 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-lg p-3 overflow-auto max-h-64 text-slate-700 dark:text-slate-300">
          {JSON.stringify(jobView, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
