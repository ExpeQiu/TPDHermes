"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, readJson } from "@/lib/api";

export default function NewProjectPage() {
  const router = useRouter();
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
      await readJson(res);
      setSubmitting(false);
      router.push("/projects");
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition";

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-6">新建项目</h1>

        {submitError && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 mb-4">
            提交失败: {submitError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 项目名称 */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
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
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
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
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
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
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
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
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              约束条件
            </label>
            <textarea
              value={form.constraints}
              onChange={(e) =>
                setForm({ ...form, constraints: e.target.value })
              }
              placeholder='如：{"字数": 2000, "格式": "JSON"} 或普通文本描述'
              rows={3}
              className={inputCls + " resize-none"}
            />
          </div>

          {/* 提交按钮 */}
          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="px-6 py-2.5 bg-blue-600 rounded-lg hover:bg-blue-500 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              {submitting ? "创建中..." : "创建项目"}
            </button>
            <button
              type="button"
              onClick={() => router.back()}
              className="px-6 py-2.5 bg-slate-700 rounded-lg hover:bg-slate-600 transition font-medium"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
