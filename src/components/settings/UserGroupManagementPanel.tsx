"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PLATFORM_ROLE_OPTIONS,
  type PlatformRole,
} from "@/lib/rbac";
import {
  assignUserPlatformRole,
  fetchManagedUsers,
  type ManagedUserRow,
} from "@/lib/user-admin";

const ASSIGNABLE_ROLES = PLATFORM_ROLE_OPTIONS.filter((opt) => opt.value !== "platform_admin");

function roleLabel(role: string | null | undefined): string {
  return ASSIGNABLE_ROLES.find((opt) => opt.value === role)?.label || role || "未设置";
}

export default function UserGroupManagementPanel({ enabled = true }: { enabled?: boolean }) {
  const [users, setUsers] = useState<ManagedUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<PlatformRole>("tenant_partner");

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const rows = await fetchManagedUsers();
      setUsers(rows);
      setSelectedId((prev) => {
        if (prev && rows.some((row) => row.user_id === prev)) return prev;
        return rows[0]?.user_id ?? null;
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "加载用户列表失败";
      setErr(
        message === "Not Found" || message.includes("404")
          ? "用户列表接口未就绪，请执行 ./stop.sh && ./start.sh 重启后端"
          : message,
      );
      setUsers([]);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setUsers([]);
      setSelectedId(null);
      setLoading(false);
      setErr("");
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (user) =>
        user.user_id.toLowerCase().includes(q) ||
        user.display_name.toLowerCase().includes(q) ||
        (user.platform_role_label || "").toLowerCase().includes(q) ||
        user.resolved_platform_role_label.toLowerCase().includes(q),
    );
  }, [query, users]);

  const selected = useMemo(
    () => users.find((user) => user.user_id === selectedId) ?? null,
    [selectedId, users],
  );

  useEffect(() => {
    if (!selected) return;
    const current = (selected.platform_role || selected.resolved_platform_role) as PlatformRole;
    setDraftRole(current);
  }, [selected]);

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setErr("");
    try {
      await assignUserPlatformRole(selected.user_id, draftRole);
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "保存分组失败");
    } finally {
      setSaving(false);
    }
  };

  const draftHint = ASSIGNABLE_ROLES.find((opt) => opt.value === draftRole)?.hint;

  if (!enabled) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
        <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">用户分组管理</h2>
        <p className="mt-1 text-xs text-slate-500">
          左侧选择 User ID，右侧查看详情并编辑平台分组（系统管理员专属）。
        </p>
      </div>

      <div className="grid min-h-[360px] grid-cols-1 lg:grid-cols-[minmax(240px,300px)_1fr]">
        <aside className="border-b border-slate-200 lg:border-b-0 lg:border-r dark:border-slate-800">
          <div className="border-b border-slate-200 p-3 dark:border-slate-800">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 User ID / 昵称 / 分组"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {loading && <p className="p-4 text-sm text-slate-500">加载中…</p>}
            {!loading && filteredUsers.length === 0 && (
              <p className="p-4 text-sm text-slate-500">暂无已同步 User ID 的用户。</p>
            )}
            {!loading &&
              filteredUsers.map((user) => {
                const active = user.user_id === selectedId;
                const badge = user.resolved_platform_role_label || roleLabel(user.platform_role);
                return (
                  <button
                    key={user.user_id}
                    type="button"
                    onClick={() => setSelectedId(user.user_id)}
                    className={`flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 dark:border-slate-800/80 ${
                      active
                        ? "bg-blue-50/80 dark:bg-blue-950/30"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
                      {user.avatar_initial}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {user.display_name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">
                        {user.user_id}
                      </span>
                      <span className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {badge}
                      </span>
                    </span>
                  </button>
                );
              })}
          </div>
        </aside>

        <div className="p-5">
          {!selected && !loading && (
            <p className="text-sm text-slate-500">请从左侧选择一个 User ID 查看详情。</p>
          )}

          {selected && (
            <div className="space-y-5">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-400">用户详情</p>
                <h3 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {selected.display_name}
                </h3>
                <dl className="mt-4 space-y-3 text-sm">
                  <div>
                    <dt className="text-slate-500">User ID</dt>
                    <dd className="mt-0.5 break-all font-mono text-slate-900 dark:text-slate-100">
                      {selected.user_id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">统一 ID</dt>
                    <dd className="mt-0.5 break-all font-mono text-slate-900 dark:text-slate-100">
                      {selected.unified_user_id}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">当前生效分组</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {selected.resolved_platform_role_label}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">已保存分组</dt>
                    <dd className="mt-0.5 text-slate-900 dark:text-slate-100">
                      {selected.platform_role_label || "未单独保存（使用默认规则）"}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <label className="block text-sm">
                  <span className="text-slate-500 dark:text-slate-400">编辑平台分组</span>
                  <select
                    className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    value={draftRole}
                    onChange={(e) => setDraftRole(e.target.value as PlatformRole)}
                    disabled={saving}
                  >
                    {ASSIGNABLE_ROLES.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                {draftHint && <p className="mt-2 text-xs text-slate-500">{draftHint}</p>}
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
                >
                  {saving ? "保存中…" : "保存分组"}
                </button>
              </div>
            </div>
          )}

          {err && <p className="mt-4 text-sm text-red-500 dark:text-red-400">{err}</p>}
        </div>
      </div>
    </div>
  );
}
