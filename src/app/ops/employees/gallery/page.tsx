"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiGet, apiPost } from "@/lib/api";

type EmployeeCard = {
  id: string;
  display_name: string;
  role_name: string;
  description: string;
  can_use: boolean;
  can_manage: boolean;
};

export default function EmployeeGalleryPage() {
  const [items, setItems] = useState<EmployeeCard[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<{ items: EmployeeCard[] }>("/employees?scope=gallery")
      .then((data) => setItems(data.items || []))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  const copy = async (id: string, name: string) => {
    const created = await apiPost<{ id: string }>("/employees", {
      name: `${name.split(" @")[0]} 副本`,
      source_mode: "copy",
      copy_from_id: id,
    });
    window.location.href = `/ops/employees/${created.id}`;
  };

  return (
    <section aria-label="开放广场">
        <Link href="/ops/employees" className="text-sm text-slate-500">
          ← 花名册
        </Link>
        <h2 className="mt-3 text-2xl font-bold">开放广场</h2>
        <p className="mt-2 text-sm text-slate-500">这里只陈列已发布的员工，用来浏览和复制。广场本身不能聊天。</p>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        <ul className="mt-6 space-y-3">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
              <Link href={`/ops/employees/${item.id}`} className="font-medium hover:underline">
                {item.display_name}
              </Link>
              <div className="text-sm text-slate-500">{item.role_name}</div>
              <p className="mt-1 text-sm">{item.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/ops/employees/${item.id}`}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                >
                  {item.can_manage ? "查看并编辑岗位" : "查看档案"}
                </Link>
                <button
                  type="button"
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white dark:bg-white dark:text-slate-900"
                  onClick={() => void copy(item.id, item.display_name)}
                >
                  复制上岗
                </button>
              </div>
              {!item.can_use ? <p className="mt-2 text-xs text-slate-500">尚未使用或未被项目钉住，不能直接开始对话。</p> : null}
            </li>
          ))}
        </ul>
    </section>
  );
}
