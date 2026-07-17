"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

interface PackMeta {
  id: string;
  name: string;
  description?: string;
  roles: number;
  experts: number;
}

interface RoundtableRole {
  id: string;
  name: string;
  perspective: string;
}

interface ConsultExpert {
  id: string;
  name: string;
  tool: string;
  when: string;
}

interface PackDetail {
  id: string;
  name: string;
  description: string;
  roundtable_roles: RoundtableRole[];
  consult_experts: ConsultExpert[];
  source?: string;
}

interface RoleMeta {
  id: string;
  name: string;
  kinds: string[];
}

interface RoleDetail {
  id: string;
  name: string;
  perspective?: string;
  tool?: string;
  when?: string;
}

const blankPack = (): PackDetail => ({
  id: "",
  name: "",
  description: "",
  roundtable_roles: [
    { id: "moderator", name: "主持人", perspective: "控场、升维冲突、收束可执行方案" },
    { id: "analyst", name: "分析师", perspective: "拆解目标与约束" },
  ],
  consult_experts: [
    { id: "domain", name: "领域专家", tool: "consult_domain", when: "需要领域判断" },
  ],
});

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
const labelClass = "block text-sm text-slate-500 dark:text-slate-400";
const btnSecondary =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500";
const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";

export default function PackManagementPanel() {
  const [items, setItems] = useState<PackMeta[]>([]);
  const [catalog, setCatalog] = useState<RoleMeta[]>([]);
  const [draft, setDraft] = useState<PackDetail>(blankPack());
  const [creating, setCreating] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [importRt, setImportRt] = useState("");
  const [importCs, setImportCs] = useState("");

  const refreshList = useCallback(async (selectId?: string | null) => {
    const data = await apiGet<{ items: PackMeta[]; source?: string }>("/brainstorm/packs");
    setItems(data.items || []);
    if (data.source) setSource(data.source);
    if (selectId !== undefined) setSelectedId(selectId);
    return data.items || [];
  }, []);

  const loadCatalog = useCallback(async () => {
    const data = await apiGet<{ items: RoleMeta[] }>("/brainstorm/roles");
    setCatalog(data.items || []);
  }, []);

  const openPack = useCallback(async (id: string) => {
    setError("");
    setStatus(`加载 ${id}…`);
    const data = await apiGet<PackDetail>(`/brainstorm/packs/${encodeURIComponent(id)}`);
    setDraft({
      id: data.id,
      name: data.name || "",
      description: data.description || "",
      roundtable_roles: data.roundtable_roles || [],
      consult_experts: data.consult_experts || [],
    });
    setCreating(false);
    setSelectedId(id);
    if (data.source) setSource(data.source);
    setStatus(`已加载 ${id}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [list] = await Promise.all([refreshList(), loadCatalog()]);
        if (cancelled) return;
        if (list.length) await openPack(list[0].id);
        else {
          setDraft(blankPack());
          setCreating(true);
          setSelectedId(null);
          setStatus("填写后保存为新 Pack");
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshList, loadCatalog, openPack]);

  const startNew = () => {
    setDraft(blankPack());
    setCreating(true);
    setSelectedId(null);
    setStatus("填写后保存为新 Pack");
    setError("");
  };

  const updateRole = (index: number, patch: Partial<RoundtableRole>) => {
    setDraft((prev) => {
      const next = [...prev.roundtable_roles];
      next[index] = { ...next[index], ...patch };
      return { ...prev, roundtable_roles: next };
    });
  };

  const updateExpert = (index: number, patch: Partial<ConsultExpert>) => {
    setDraft((prev) => {
      const next = [...prev.consult_experts];
      next[index] = { ...next[index], ...patch };
      return { ...prev, consult_experts: next };
    });
  };

  const importRole = async (kind: "roundtable" | "consult") => {
    const rid = kind === "roundtable" ? importRt : importCs;
    if (!rid) {
      setError("请先选择角色");
      return;
    }
    try {
      const data = await apiGet<RoleDetail>(`/brainstorm/roles/${encodeURIComponent(rid)}`);
      if (kind === "roundtable") {
        if (draft.roundtable_roles.some((r) => r.id === data.id)) {
          setError(`已存在 ${data.id}`);
          return;
        }
        setDraft((prev) => ({
          ...prev,
          roundtable_roles: [
            ...prev.roundtable_roles,
            { id: data.id, name: data.name, perspective: data.perspective || "" },
          ],
        }));
      } else {
        if (draft.consult_experts.some((r) => r.id === data.id)) {
          setError(`已存在 ${data.id}`);
          return;
        }
        setDraft((prev) => ({
          ...prev,
          consult_experts: [
            ...prev.consult_experts,
            {
              id: data.id,
              name: data.name,
              tool: data.tool || `consult_${data.id}`,
              when: data.when || "",
            },
          ],
        }));
      }
      setError("");
      setStatus(`已导入 ${data.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "导入失败");
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setStatus("保存中…");
    try {
      const payload = {
        id: draft.id.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        roundtable_roles: draft.roundtable_roles,
        consult_experts: draft.consult_experts,
      };
      const data = creating
        ? await apiPost<PackDetail>("/brainstorm/packs", payload)
        : await apiPut<PackDetail>(`/brainstorm/packs/${encodeURIComponent(selectedId || payload.id)}`, payload);
      setDraft({
        id: data.id,
        name: data.name || "",
        description: data.description || "",
        roundtable_roles: data.roundtable_roles || [],
        consult_experts: data.consult_experts || [],
      });
      setCreating(false);
      await refreshList(data.id);
      if (data.source) setSource(data.source);
      setStatus(`已保存 ${data.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
      setStatus("");
    } finally {
      setSaving(false);
    }
  };

  const rtOptions = catalog.filter((r) => (r.kinds || []).includes("roundtable"));
  const csOptions = catalog.filter((r) => (r.kinds || []).includes("consult"));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          文件落在 <code>multi_agent/skill_packs/*/pack.yml</code>
          {source ? ` · 数据源 ${source}` : ""}
        </p>
        <button type="button" onClick={startNew} className={btnSecondary}>
          新建 Pack
        </button>
      </div>

      {loading && <p className="text-sm text-slate-500">加载中…</p>}
      {error && <p className="mb-3 text-sm text-red-500 dark:text-red-400">{error}</p>}
      {status && !error && <p className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}

      {!loading && (
        <div className="grid gap-4 lg:grid-cols-[minmax(14rem,20rem)_1fr]">
          <aside className="rounded-2xl border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/50">
            <h3 className="text-sm font-medium text-slate-800 dark:text-slate-200">已安装</h3>
            <ul className="mt-3 space-y-1">
              {items.length === 0 && (
                <li className="text-sm text-slate-500">暂无 Pack</li>
              )}
              {items.map((p) => {
                const active = selectedId === p.id && !creating;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => openPack(p.id).catch((e: unknown) => setError(e instanceof Error ? e.message : "打开失败"))}
                      className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                        active
                          ? "bg-blue-500/10 ring-1 ring-blue-500/30"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                        {p.id}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {p.name} · 角色 {p.roles} · 专家 {p.experts}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <h3 className="text-lg font-medium text-slate-900 dark:text-white">
              {creating ? "新建 Pack" : `编辑 · ${draft.id}`}
            </h3>

            <div className="mt-4 space-y-4">
              <label className={labelClass}>
                ID（kebab-case）
                <input
                  className={inputClass}
                  value={draft.id}
                  readOnly={!creating}
                  onChange={(e) => setDraft((p) => ({ ...p, id: e.target.value }))}
                  placeholder="如 content-lab"
                  pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
                />
              </label>
              <label className={labelClass}>
                名称
                <input
                  className={inputClass}
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="显示名称"
                />
              </label>
              <label className={labelClass}>
                说明
                <textarea
                  className={`${inputClass} min-h-[4rem]`}
                  value={draft.description}
                  onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
                  placeholder="一句话描述适用场景"
                />
              </label>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-slate-800 dark:text-slate-200">圆桌角色</h4>
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    onClick={() =>
                      setDraft((p) => ({
                        ...p,
                        roundtable_roles: [...p.roundtable_roles, { id: "", name: "", perspective: "" }],
                      }))
                    }
                  >
                    + 手写
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    className={`${inputClass} mt-0 max-w-xs`}
                    value={importRt}
                    onChange={(e) => setImportRt(e.target.value)}
                    aria-label="从角色库导入圆桌"
                  >
                    <option value="">从角色库选圆桌…</option>
                    {rtOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id} · {r.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className={btnSecondary} onClick={() => void importRole("roundtable")}>
                    导入
                  </button>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  需包含 id 为 <code>moderator</code> 的主持人；缺失时保存会自动补上。
                </p>
                <div className="mt-3 space-y-3">
                  {draft.roundtable_roles.map((role, i) => (
                    <div
                      key={`rt-${i}`}
                      className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800"
                    >
                      <label className={labelClass}>
                        id
                        <input
                          className={inputClass}
                          value={role.id}
                          onChange={(e) => updateRole(i, { id: e.target.value })}
                        />
                      </label>
                      <label className={labelClass}>
                        name
                        <input
                          className={inputClass}
                          value={role.name}
                          onChange={(e) => updateRole(i, { name: e.target.value })}
                        />
                      </label>
                      <label className={`${labelClass} sm:col-span-2`}>
                        perspective
                        <input
                          className={inputClass}
                          value={role.perspective}
                          onChange={(e) => updateRole(i, { perspective: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-left text-xs text-red-500 hover:underline sm:col-span-2"
                        onClick={() =>
                          setDraft((p) => ({
                            ...p,
                            roundtable_roles: p.roundtable_roles.filter((_, idx) => idx !== i),
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-slate-800 dark:text-slate-200">Consult 专家</h4>
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    onClick={() =>
                      setDraft((p) => ({
                        ...p,
                        consult_experts: [
                          ...p.consult_experts,
                          { id: "", name: "", tool: "", when: "" },
                        ],
                      }))
                    }
                  >
                    + 手写
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    className={`${inputClass} mt-0 max-w-xs`}
                    value={importCs}
                    onChange={(e) => setImportCs(e.target.value)}
                    aria-label="从角色库导入专家"
                  >
                    <option value="">从角色库选专家…</option>
                    {csOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id} · {r.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className={btnSecondary} onClick={() => void importRole("consult")}>
                    导入
                  </button>
                </div>
                <div className="mt-3 space-y-3">
                  {draft.consult_experts.map((expert, i) => (
                    <div
                      key={`ex-${i}`}
                      className="grid gap-2 rounded-xl border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800"
                    >
                      <label className={labelClass}>
                        id
                        <input
                          className={inputClass}
                          value={expert.id}
                          onChange={(e) => updateExpert(i, { id: e.target.value })}
                        />
                      </label>
                      <label className={labelClass}>
                        name
                        <input
                          className={inputClass}
                          value={expert.name}
                          onChange={(e) => updateExpert(i, { name: e.target.value })}
                        />
                      </label>
                      <label className={labelClass}>
                        tool
                        <input
                          className={inputClass}
                          value={expert.tool}
                          onChange={(e) => updateExpert(i, { tool: e.target.value })}
                        />
                      </label>
                      <label className={labelClass}>
                        when
                        <input
                          className={inputClass}
                          value={expert.when}
                          onChange={(e) => updateExpert(i, { when: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="text-left text-xs text-red-500 hover:underline sm:col-span-2"
                        onClick={() =>
                          setDraft((p) => ({
                            ...p,
                            consult_experts: p.consult_experts.filter((_, idx) => idx !== i),
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <button type="button" disabled={saving} onClick={() => void save()} className={btnPrimary}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
