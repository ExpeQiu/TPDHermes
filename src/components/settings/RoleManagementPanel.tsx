"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

interface RoleMeta {
  id: string;
  name: string;
  description?: string;
  kinds: string[];
}

interface RoleDetail {
  id: string;
  name: string;
  description: string;
  kinds: string[];
  perspective: string;
  tool: string;
  when: string;
  system: string;
  source?: string;
}

const blankRole = (): RoleDetail => ({
  id: "",
  name: "",
  description: "",
  kinds: ["roundtable"],
  perspective: "",
  tool: "",
  when: "",
  system: "",
});

const inputClass =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";
const labelClass = "block text-sm text-slate-500 dark:text-slate-400";
const btnSecondary =
  "rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500";
const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50";

export default function RoleManagementPanel() {
  const [items, setItems] = useState<RoleMeta[]>([]);
  const [draft, setDraft] = useState<RoleDetail>(blankRole());
  const [creating, setCreating] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");

  const refreshList = useCallback(async (selectId?: string | null) => {
    const data = await apiGet<{ items: RoleMeta[]; source?: string }>("/brainstorm/roles");
    setItems(data.items || []);
    if (data.source) setSource(data.source);
    if (selectId !== undefined) setSelectedId(selectId);
    return data.items || [];
  }, []);

  const openRole = useCallback(async (id: string) => {
    setError("");
    setStatus(`加载 ${id}…`);
    const data = await apiGet<RoleDetail>(`/brainstorm/roles/${encodeURIComponent(id)}`);
    setDraft({
      id: data.id,
      name: data.name || "",
      description: data.description || "",
      kinds: data.kinds || [],
      perspective: data.perspective || "",
      tool: data.tool || "",
      when: data.when || "",
      system: data.system || "",
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
        const list = await refreshList();
        if (cancelled) return;
        if (list.length) await openRole(list[0].id);
        else {
          setDraft(blankRole());
          setCreating(true);
          setSelectedId(null);
          setStatus("填写后保存为新角色");
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
  }, [refreshList, openRole]);

  const startNew = () => {
    setDraft(blankRole());
    setCreating(true);
    setSelectedId(null);
    setStatus("填写后保存为新角色");
    setError("");
  };

  const toggleKind = (kind: "roundtable" | "consult") => {
    setDraft((prev) => {
      const set = new Set(prev.kinds);
      if (set.has(kind)) set.delete(kind);
      else set.add(kind);
      return { ...prev, kinds: [...set] };
    });
  };

  const save = async () => {
    if (!draft.kinds.length) {
      setError("至少勾选一种 kind");
      return;
    }
    setSaving(true);
    setError("");
    setStatus("保存中…");
    try {
      const payload = {
        id: draft.id.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        kinds: draft.kinds,
        perspective: draft.perspective.trim(),
        tool: draft.tool.trim(),
        when: draft.when.trim(),
        system: draft.system.trim(),
      };
      const data = creating
        ? await apiPost<RoleDetail>("/brainstorm/roles", payload)
        : await apiPut<RoleDetail>(
            `/brainstorm/roles/${encodeURIComponent(selectedId || payload.id)}`,
            payload,
          );
      setDraft({
        id: data.id,
        name: data.name || "",
        description: data.description || "",
        kinds: data.kinds || [],
        perspective: data.perspective || "",
        tool: data.tool || "",
        when: data.when || "",
        system: data.system || "",
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

  const remove = async () => {
    if (!selectedId || creating) return;
    if (
      !window.confirm(
        `确认删除角色 ${selectedId}？Pack 仍可内联引用该 id，但不再从角色库合并。`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError("");
    setStatus("删除中…");
    try {
      await apiDelete(`/brainstorm/roles/${encodeURIComponent(selectedId)}`);
      const list = await refreshList(null);
      if (list.length) await openRole(list[0].id);
      else {
        setDraft(blankRole());
        setCreating(true);
        setSelectedId(null);
      }
      setStatus(`已删除 ${selectedId}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "删除失败");
      setStatus("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          文件落在 <code>multi_agent/roles/*.yml</code>
          {source ? ` · 数据源 ${source}` : ""}
        </p>
        <button type="button" onClick={startNew} className={btnSecondary}>
          新建角色
        </button>
      </div>

      {loading && <p className="text-sm text-slate-500">加载中…</p>}
      {error && <p className="mb-3 text-sm text-red-500 dark:text-red-400">{error}</p>}
      {status && !error && <p className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}

      {!loading && (
        <div className="grid gap-4 lg:grid-cols-[minmax(14rem,20rem)_1fr]">
          <aside className="rounded-2xl border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/50">
            <h3 className="text-sm font-medium text-slate-800 dark:text-slate-200">角色库</h3>
            <ul className="mt-3 space-y-1">
              {items.length === 0 && <li className="text-sm text-slate-500">暂无角色</li>}
              {items.map((r) => {
                const active = selectedId === r.id && !creating;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() =>
                        openRole(r.id).catch((e: unknown) =>
                          setError(e instanceof Error ? e.message : "打开失败"),
                        )
                      }
                      className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                        active
                          ? "bg-blue-500/10 ring-1 ring-blue-500/30"
                          : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                        {r.id}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {r.name} · {(r.kinds || []).join(" · ") || "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <h3 className="text-lg font-medium text-slate-900 dark:text-white">
              {creating ? "新建角色" : `编辑 · ${draft.id}`}
            </h3>

            <div className="mt-4 space-y-4">
              <label className={labelClass}>
                ID（snake_case）
                <input
                  className={inputClass}
                  value={draft.id}
                  readOnly={!creating}
                  onChange={(e) => setDraft((p) => ({ ...p, id: e.target.value }))}
                  placeholder="如 content_director"
                  pattern="[a-z][a-z0-9_]*"
                />
              </label>
              <label className={labelClass}>
                名称
                <input
                  className={inputClass}
                  value={draft.name}
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  placeholder="显示名"
                />
              </label>
              <label className={labelClass}>
                说明
                <textarea
                  className={`${inputClass} min-h-[4rem]`}
                  value={draft.description}
                  onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
                  placeholder="一句话职责"
                />
              </label>

              <fieldset>
                <legend className="text-sm text-slate-500 dark:text-slate-400">能力 kinds</legend>
                <div className="mt-2 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={draft.kinds.includes("roundtable")}
                      onChange={() => toggleKind("roundtable")}
                    />
                    roundtable
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
                    <input
                      type="checkbox"
                      checked={draft.kinds.includes("consult")}
                      onChange={() => toggleKind("consult")}
                    />
                    consult
                  </label>
                </div>
              </fieldset>

              <label className={labelClass}>
                perspective（圆桌视角）
                <input
                  className={inputClass}
                  value={draft.perspective}
                  onChange={(e) => setDraft((p) => ({ ...p, perspective: e.target.value }))}
                  placeholder="对立立场 / 关注点"
                />
              </label>
              <label className={labelClass}>
                tool（Consult 工具名）
                <input
                  className={inputClass}
                  value={draft.tool}
                  onChange={(e) => setDraft((p) => ({ ...p, tool: e.target.value }))}
                  placeholder="consult_xxx"
                />
              </label>
              <label className={labelClass}>
                when（何时调用）
                <input
                  className={inputClass}
                  value={draft.when}
                  onChange={(e) => setDraft((p) => ({ ...p, when: e.target.value }))}
                  placeholder="触发条件"
                />
              </label>
              <label className={labelClass}>
                system prompt
                <textarea
                  className={`${inputClass} min-h-[8rem] font-mono text-xs`}
                  value={draft.system}
                  onChange={(e) => setDraft((p) => ({ ...p, system: e.target.value }))}
                  placeholder="注入 LLM 的角色设定"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={saving} onClick={() => void save()} className={btnPrimary}>
                  {saving ? "保存中…" : "保存"}
                </button>
                {!creating && (
                  <button type="button" disabled={saving} onClick={() => void remove()} className={btnSecondary}>
                    删除
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
