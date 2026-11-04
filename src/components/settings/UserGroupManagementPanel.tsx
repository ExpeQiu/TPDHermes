"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PLATFORM_ROLE_OPTIONS,
  featuresForPlatformRole,
  type PlatformRole,
} from "@/lib/rbac";
import {
  assignUserPlatformRole,
  fetchManagedUsers,
  updateManagedUserProfile,
  type ManagedUserRow,
} from "@/lib/user-admin";
import { accessibleWorkflowPages } from "@/lib/workflow-nav";

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
  const [draftName, setDraftName] = useState("");
  const [draftEmployeeId, setDraftEmployeeId] = useState("");
  const [draftOrgId, setDraftOrgId] = useState("");

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
        user.display_name.toLowerCase().includes(q) ||
        (user.employee_id || "").toLowerCase().includes(q) ||
        (user.org_id || "").toLowerCase().includes(q) ||
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
    setDraftName(selected.display_name || "");
    setDraftEmployeeId(selected.employee_id || "");
    setDraftOrgId(selected.org_id || "");
  }, [selected]);

  const permissionPages = useMemo(
    () =>
      accessibleWorkflowPages({
        features: featuresForPlatformRole(draftRole),
        platformRole: draftRole,
      }),
    [draftRole],
  );
  const draftRoleLabel = PLATFORM_ROLE_OPTIONS.find((opt) => opt.value === draftRole)?.label || draftRole;

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setErr("");
    try {
      await updateManagedUserProfile(selected.user_id, {
        display_name: draftName.trim(),
        employee_id: draftEmployeeId.trim(),
        org_id: draftOrgId.trim(),
      });
      await assignUserPlatformRole(selected.user_id, draftRole);
      console.info("[settings] 已保存用户与分组", {
        user_id: selected.user_id,
        role: draftRole,
      });
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!enabled) return null;

  return (
    <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
      <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/50">
        <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">用户</h2>
        </div>
          <div className="border-b border-slate-200 p-3 dark:border-slate-800">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索用户名、工号或组织"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          <div className="max-h-[640px] overflow-y-auto">
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
                      <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                        {user.employee_id || user.org_id
                          ? `工号 ${user.employee_id || "未填写"} · 组织 ${user.org_id || "未填写"}`
                          : "工号未填写"}
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

      <section
        aria-label="权限管理"
        className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50"
      >
        {!selected && !loading && <p className="text-sm text-slate-500">请从左侧选择一个用户。</p>}
        {selected && (
          <div className="space-y-5">
            <div>
              <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">用户详情</h2>
              <div className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="text-slate-500">用户名</span>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-500">工号</span>
                  <input
                    value={draftEmployeeId}
                    onChange={(e) => setDraftEmployeeId(e.target.value)}
                    placeholder="未填写"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-500">组织</span>
                  <input
                    value={draftOrgId}
                    onChange={(e) => setDraftOrgId(e.target.value)}
                    placeholder="未填写"
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-500">分组</span>
                  <select
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    value={draftRole}
                    onChange={(e) => setDraftRole(e.target.value as PlatformRole)}
                    disabled={saving}
                  >
                    {PLATFORM_ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div>
              <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">权限管理</h2>
              <p className="mt-1 text-xs text-slate-500">
                分组「{draftRoleLabel}」可访问的页面
              </p>
              <ul className="mt-3 space-y-2">
                {permissionPages.map((page) => (
                  <li
                    key={page.href}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/80"
                  >
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{page.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{page.description}</p>
                  </li>
                ))}
              </ul>
            </div>

            {err && <p className="text-sm text-red-500">{err}</p>}
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !draftName.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
