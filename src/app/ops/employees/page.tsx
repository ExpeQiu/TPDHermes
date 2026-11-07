"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { apiGet, apiPost } from "@/lib/api";

type EmployeeCard = {
  id: string;
  display_name: string;
  role_name: string;
  status: string;
  published_to_gallery: boolean;
  binding_count: number;
  can_manage: boolean;
  can_use: boolean;
};

export default function EmployeesPage() {
  const [items, setItems] = useState<EmployeeCard[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = () => {
    apiGet<{ items: EmployeeCard[] }>("/employees?scope=roster")
      .then((data) => setItems(data.items || []))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  };

  useEffect(() => {
    load();
  }, []);

  const createBlank = async () => {
    setError("");
    try {
      const created = await apiPost<EmployeeCard>("/employees", {
        name: name.trim(),
        source_mode: "blank",
        role_name: "待补充",
      });
      window.location.href = `/ops/employees/${created.id}`;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <section aria-label="数字员工">
        <p className="text-sm text-slate-500">花名册列出你能看见的员工。对话里只出现你能运行的在岗员工。</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="新员工姓名"
            className="rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          />
          <button type="button" onClick={() => void createBlank()} className="rounded-lg bg-slate-900 px-4 py-2 text-white dark:bg-white dark:text-slate-900">
            新建
          </button>
          <Link href="/ops/employees/gallery" className="rounded-lg border border-slate-300 px-4 py-2">
            从广场复制
          </Link>
        </div>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        {!items.length ? (
          <p className="mt-8 text-slate-500">还没有数字员工。新建一位，或从广场复制已发布的配置。</p>
        ) : (
          <ul className="mt-6 divide-y divide-slate-200 dark:divide-slate-800">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link href={`/ops/employees/${item.id}`} className="font-medium hover:underline">
                    {item.display_name}
                  </Link>
                  <div className="text-sm text-slate-500">
                    {item.role_name} · 能力 {item.binding_count} · {item.status === "active" ? "在岗" : "归档"}
                    {item.published_to_gallery ? " · 已发布" : ""}
                  </div>
                </div>
                {item.can_use ? (
                  <Link href={`/chat?employee_id=${item.id}`} className="text-sm text-blue-600">
                    对话
                  </Link>
                ) : (
                  <span className="text-sm text-slate-400">不可对话</span>
                )}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
