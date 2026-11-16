"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiGet, apiPost } from "@/lib/api";
import { CONTENT_MAX_CLASS, PAGE_MAIN_CLASS } from "@/lib/content-shell";
import { DEFAULT_PROMOTION_PRODUCTS, PROMOTION_PRODUCTS } from "@/lib/promotion-package";

interface ProjectFile {
  id: string;
  kind: string;
  title: string;
}

interface PackageSummary {
  id: string;
  status: string;
  products: string[];
  updated_at?: string;
}

export default function PromotionEntryPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id || "");
  const router = useRouter();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [products, setProducts] = useState<string[]>([...DEFAULT_PROMOTION_PRODUCTS]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    void apiGet<{ items: ProjectFile[] }>(`/projects/${projectId}/files`)
      .then((body) => setFiles(body.items ?? []))
      .catch((err: Error) => setError(err.message));
    void apiGet<{ items: PackageSummary[] }>(`/projects/${projectId}/promotion-packages`)
      .then((body) => setPackages(body.items ?? []))
      .catch((err: Error) => setError(err.message));
  }, [projectId]);

  function toggle(list: string[], value: string, checked: boolean): string[] {
    if (checked) return list.includes(value) ? list : [...list, value];
    return list.filter((item) => item !== value);
  }

  async function createPackage() {
    setBusy(true);
    setError("");
    try {
      const created = await apiPost<{ id: string }>(`/projects/${projectId}/promotion-packages`, {
        idempotency_key: idempotencyKey,
        products,
        file_refs: files
          .filter((file) => selected.includes(file.id))
          .map((file) => ({ file_id: file.id, kind: file.kind })),
      });
      router.push(`/projects/${projectId}/promotion/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={PAGE_MAIN_CLASS}>
      <div className={`${CONTENT_MAX_CLASS} space-y-6`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">技术推广包</p>
          <h1 className="mt-2 text-2xl font-semibold">选择资料与出品</h1>
        </div>
        <Link href={`/projects/${projectId}`} className="text-sm text-slate-500">
          返回项目
        </Link>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <section className="rounded-3xl border border-slate-300 p-5 dark:border-slate-700">
          <h2 className="font-medium">资料</h2>
          <div className="mt-3 space-y-2">
            {files.map((file) => (
              <label key={file.id} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(file.id)}
                  onChange={(event) => setSelected(toggle(selected, file.id, event.target.checked))}
                />
                <span className="min-w-0 break-words">
                  {file.title}
                  <span className="mt-0.5 block text-xs text-slate-400">{file.kind}</span>
                </span>
              </label>
            ))}
            {files.length === 0 ? <p className="text-sm text-slate-500">这个项目还没有可选文件。</p> : null}
          </div>
        </section>
        <section className="rounded-3xl border border-slate-300 p-5 dark:border-slate-700">
          <h2 className="font-medium">出品</h2>
          <div className="mt-3 space-y-3 text-sm">
            {PROMOTION_PRODUCTS.map((product) => (
              <label key={product.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={products.includes(product.id)}
                  onChange={(event) => setProducts(toggle(products, product.id, event.target.checked))}
                />
                {product.label}
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={busy || selected.length === 0 || products.length === 0}
            onClick={() => void createPackage()}
            className="mt-4 rounded-full bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            创建任务
          </button>
        </section>
        <section className="rounded-3xl border border-slate-300 p-5 dark:border-slate-700">
          <h2 className="font-medium">导出</h2>
          <p className="mt-2 text-xs text-slate-500">打开任务后勾选已批准版本下载。</p>
          <div className="mt-3 space-y-2">
            {packages.map((item) => (
              <Link
                key={item.id}
                href={`/projects/${projectId}/promotion/${item.id}`}
                className="block rounded-2xl bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800"
              >
                {item.status} · {(item.products || []).join("、")}
              </Link>
            ))}
            {packages.length === 0 ? <p className="text-sm text-slate-500">还没有可导出的推广包。</p> : null}
          </div>
        </section>
      </div>
      </div>
    </main>
  );
}
