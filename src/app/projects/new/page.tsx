"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { uploadProjectAttachment } from "@/lib/co-create-api";
import { trackUsage } from "@/lib/usage-tracker";

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function NewProjectPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    name: "",
    background: "",
    target_audience: "",
    deadline: "",
    constraints: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "项目名称为必填项";
    return errs;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setSubmitting(true);
    setSubmitError(null);
    try {
      let constraints: Record<string, unknown> | null = null;
      if (form.constraints.trim()) {
        try {
          constraints = JSON.parse(form.constraints) as Record<string, unknown>;
        } catch {
          constraints = { notes: form.constraints };
        }
      }
      const res = await apiFetch("/projects/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          background: form.background || null,
          audience: form.target_audience || null,
          deadline: form.deadline || null,
          constraints,
        }),
      });
      const created = await readJson<{ id: string }>(res);
      if (pendingFiles.length > 0) {
        setAttachmentUploading(true);
        const failed: string[] = [];
        for (const file of pendingFiles) {
          try {
            await uploadProjectAttachment(created.id, file);
            trackUsage({
              eventName: "project_attachment_upload",
              feature: "projects_attachments",
              action: "upload",
              projectId: created.id,
              properties: { file_name: file.name, size: file.size },
            });
          } catch (uploadErr) {
            failed.push(file.name);
            console.warn("[new-project] 附件上传失败", {
              projectId: created.id,
              fileName: file.name,
              err: uploadErr,
            });
          }
        }
        setAttachmentUploading(false);
        if (failed.length > 0) {
          setSubmitError(
            `项目已创建，但以下附件上传失败：${failed.join("、")}。可在项目详情页重试。`,
          );
          setSubmitting(false);
          router.push(`/projects/${created.id}`);
          return;
        }
      }
      setSubmitting(false);
      router.push("/projects");
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
      setAttachmentUploading(false);
    }
  };

  const handlePickAttachment = () => {
    trackUsage({
      eventName: "project_attachment_pick_click",
      feature: "projects_attachments",
      action: "pick_click",
    });
    fileInputRef.current?.click();
  };

  const handleAttachmentFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    trackUsage({
      eventName: "project_attachment_upload",
      feature: "projects_attachments",
      action: "upload",
      properties: { file_name: file.name, size: file.size, staged: true },
    });
    setPendingFiles((prev) => [...prev, file]);
  };

  const handleRemovePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const inputCls =
    "w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-slate-900 placeholder-slate-500 focus:outline-none focus:border-blue-500 transition dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500";

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-900 dark:to-slate-800 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mx-auto max-w-2xl">
          <h1 className="text-3xl font-bold mb-6">新建项目</h1>

        {submitError && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
            提交失败: {submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 项目名称 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              项目名称 <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="请输入项目名称"
              className={inputCls}
            />
            {errors.name && (
              <p className="text-red-400 text-sm mt-1">{errors.name}</p>
            )}
          </div>

          {/* 项目背景 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              项目背景
            </label>
            <textarea
              value={form.background}
              onChange={(e) =>
                setForm({ ...form, background: e.target.value })
              }
              placeholder="描述项目背景"
              rows={4}
              className={inputCls + " resize-none"}
            />
          </div>

          {/* 目标受众 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              目标受众
            </label>
            <input
              type="text"
              value={form.target_audience}
              onChange={(e) =>
                setForm({ ...form, target_audience: e.target.value })
              }
              placeholder="如：车企技术人员、产品经理"
              className={inputCls}
            />
          </div>

          {/* 截止日期 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              截止日期
            </label>
            <input
              type="date"
              value={form.deadline}
              onChange={(e) =>
                setForm({ ...form, deadline: e.target.value })
              }
              className={inputCls}
            />
          </div>

          {/* 约束条件 */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              约束条件
            </label>
            <textarea
              value={form.constraints}
              onChange={(e) =>
                setForm({ ...form, constraints: e.target.value })
              }
              placeholder='如：{"字数": 2000, "格式": "结构化"} 或普通文本描述'
              rows={3}
              className={inputCls + " resize-none"}
            />
          </div>

          {pendingFiles.length > 0 ? (
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                待上传附件（{pendingFiles.length}）
              </p>
              <ul className="space-y-2">
                {pendingFiles.map((file, index) => (
                  <li
                    key={`${file.name}-${file.size}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white/90 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-800/60"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-900 dark:text-slate-100" title={file.name}>
                        {file.name}
                      </p>
                      <p className="text-xs text-slate-500">{formatFileSize(file.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemovePendingFile(index)}
                      disabled={submitting || attachmentUploading}
                      className="shrink-0 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-xs text-red-900 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 提交按钮 */}
          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || attachmentUploading}
              className="px-6 py-2.5 bg-blue-600 rounded-lg hover:bg-blue-500 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {submitting
                ? attachmentUploading
                  ? "上传附件中..."
                  : "创建中..."
                : "创建项目"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleAttachmentFileChange}
            />
            <button
              type="button"
              onClick={handlePickAttachment}
              disabled={submitting || attachmentUploading}
              className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-800 transition hover:border-blue-400 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-200 dark:hover:bg-blue-500/20"
            >
              {attachmentUploading ? "上传中…" : "上传附件"}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              disabled={submitting || attachmentUploading}
              className="px-6 py-2.5 bg-slate-300 dark:bg-slate-700 rounded-lg hover:bg-slate-600 transition font-medium disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </form>
        </div>
      </div>
    </main>
  );
}
