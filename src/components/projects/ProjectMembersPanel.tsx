"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import {
  PROJECT_ROLE_OPTIONS,
  projectRoleBadgeClass,
  projectRoleLabel,
  type ProjectRole,
} from "@/lib/rbac";

interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  created_at: string;
  updated_at: string;
}

interface RegisteredUserRow {
  user_id: string;
  display_name: string;
  avatar_initial: string;
  platform_role: string | null;
  platform_role_label: string | null;
}

function MemberAvatar({
  initial,
  role,
  size = "md",
}: {
  initial: string;
  role: ProjectRole;
  size?: "md" | "lg";
}) {
  const dim = size === "lg" ? "h-12 w-12 text-base" : "h-10 w-10 text-sm";
  return (
    <div className={`relative shrink-0 ${dim}`}>
      <div
        className={`flex ${dim} items-center justify-center rounded-full border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200 font-semibold text-slate-700 dark:border-slate-600 dark:from-slate-700 dark:to-slate-800 dark:text-slate-100`}
      >
        {initial}
      </div>
      <span
        className={`absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${projectRoleBadgeClass(role)}`}
      >
        {projectRoleLabel(role)}
      </span>
    </div>
  );
}

function RoleTagPicker({
  role,
  disabled,
  onChange,
}: {
  role: ProjectRole;
  disabled?: boolean;
  onChange: (next: ProjectRole) => void;
}) {
  const options = PROJECT_ROLE_OPTIONS.filter((o) => o.value !== "owner");
  if (role === "owner") {
    return (
      <span
        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${projectRoleBadgeClass("owner")}`}
      >
        负责人
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => {
        const active = role === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50 ${
              active
                ? projectRoleBadgeClass(opt.value)
                : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-600"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ProjectMembersPanel({
  projectId,
  myRole,
  embedded = false,
}: {
  projectId: string;
  myRole?: string | null;
  embedded?: boolean;
}) {
  const canManage = myRole === "owner";
  const [members, setMembers] = useState<ProjectMemberRow[]>([]);
  const [registeredUsers, setRegisteredUsers] = useState<RegisteredUserRow[]>([]);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [busyUserIds, setBusyUserIds] = useState<Set<string>>(new Set());

  const memberByUserId = useMemo(
    () => new Map(members.map((m) => [m.user_id, m] as const)),
    [members],
  );

  const refreshMembers = useCallback(async () => {
    if (!projectId || !canManage) return;
    try {
      const rows = await apiGet<ProjectMemberRow[]>(`/projects/${projectId}/members`);
      setMembers(rows);
      setErr("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载成员失败");
    }
  }, [canManage, projectId]);

  const refreshRegisteredUsers = useCallback(async () => {
    if (!projectId || !canManage) return;
    setLoadingUsers(true);
    try {
      const rows = await apiGet<RegisteredUserRow[]>(`/projects/${projectId}/registered-users`);
      setRegisteredUsers(rows);
      setErr("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载用户列表失败");
    } finally {
      setLoadingUsers(false);
    }
  }, [canManage, projectId]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshMembers(), refreshRegisteredUsers()]);
  }, [refreshMembers, refreshRegisteredUsers]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return registeredUsers;
    return registeredUsers.filter(
      (u) =>
        u.user_id.toLowerCase().includes(q) ||
        u.display_name.toLowerCase().includes(q) ||
        (u.platform_role_label || "").toLowerCase().includes(q),
    );
  }, [registeredUsers, search]);

  const setUserBusy = (userId: string, busy: boolean) => {
    setBusyUserIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(userId);
      else next.delete(userId);
      return next;
    });
  };

  const addMember = async (userId: string, role: ProjectRole = "viewer") => {
    setUserBusy(userId, true);
    setErr("");
    try {
      await apiPost(`/projects/${projectId}/members`, { user_id: userId, role });
      await refreshMembers();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "添加失败");
    } finally {
      setUserBusy(userId, false);
    }
  };

  const updateRole = async (memberUserId: string, nextRole: ProjectRole) => {
    setUserBusy(memberUserId, true);
    setErr("");
    try {
      await apiPatch(`/projects/${projectId}/members/${encodeURIComponent(memberUserId)}`, {
        role: nextRole,
      });
      await refreshMembers();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "更新失败");
    } finally {
      setUserBusy(memberUserId, false);
    }
  };

  const removeMember = async (memberUserId: string) => {
    setUserBusy(memberUserId, true);
    setErr("");
    try {
      await apiDelete(`/projects/${projectId}/members/${encodeURIComponent(memberUserId)}`);
      await refreshMembers();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "移除失败");
    } finally {
      setUserBusy(memberUserId, false);
    }
  };

  const toggleUserMembership = async (user: RegisteredUserRow, checked: boolean) => {
    const existing = memberByUserId.get(user.user_id);
    if (existing?.role === "owner") return;
    if (checked) {
      await addMember(user.user_id, "viewer");
    } else if (existing) {
      await removeMember(user.user_id);
    }
  };

  if (!canManage) {
    if (!myRole) return null;
    return (
      <section
        className={`rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40${embedded ? "" : " mt-8"}`}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">项目成员</h3>
        <p className="mt-2 text-sm text-slate-500">你在本项目中的角色：{projectRoleLabel(myRole)}</p>
      </section>
    );
  }

  const displayForMember = (userId: string) => {
    const reg = registeredUsers.find((u) => u.user_id === userId);
    return {
      displayName: reg?.display_name || userId,
      initial: reg?.avatar_initial || userId.slice(0, 1).toUpperCase(),
      platformRoleLabel: reg?.platform_role_label,
    };
  };

  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40${embedded ? "" : " mt-8"}`}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">项目成员</h3>
          <p className="mt-1 text-xs text-slate-500">
            左侧勾选平台注册用户加入项目；右侧管理成员角色（只读 / 编辑 / 负责人）。
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="flex min-h-[280px] flex-col rounded-xl border border-slate-200 dark:border-slate-700">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">注册用户</p>
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索姓名或 User ID"
            />
          </div>
          <ul className="flex-1 space-y-1 overflow-y-auto p-2">
            {loadingUsers && registeredUsers.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-slate-500">加载用户列表…</li>
            ) : filteredUsers.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-slate-500">暂无匹配用户</li>
            ) : (
              filteredUsers.map((user) => {
                const member = memberByUserId.get(user.user_id);
                const isMember = Boolean(member);
                const isOwner = member?.role === "owner";
                const busy = busyUserIds.has(user.user_id);
                return (
                  <li key={user.user_id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                        isMember ? "bg-slate-50/80 dark:bg-slate-800/40" : ""
                      } ${isOwner || busy ? "cursor-default opacity-80" : ""}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        checked={isMember}
                        disabled={isOwner || busy}
                        onChange={(e) => void toggleUserMembership(user, e.target.checked)}
                      />
                      <div className="relative shrink-0">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:from-slate-700 dark:to-slate-800 dark:text-slate-100">
                          {user.avatar_initial}
                        </div>
                        {member ? (
                          <span
                            className={`absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border px-1 py-0.5 text-[9px] font-medium leading-none ${projectRoleBadgeClass(member.role)}`}
                          >
                            {projectRoleLabel(member.role)}
                          </span>
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                          {user.display_name}
                        </p>
                        <p className="truncate text-xs text-slate-500">{user.user_id}</p>
                        {user.platform_role_label ? (
                          <p className="truncate text-[11px] text-slate-400">{user.platform_role_label}</p>
                        ) : null}
                      </div>
                    </label>
                  </li>
                );
              })
            )}
          </ul>
        </div>

        <div className="flex min-h-[280px] flex-col rounded-xl border border-slate-200 dark:border-slate-700">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">项目成员</p>
            <p className="mt-1 text-xs text-slate-400">{members.length} 人</p>
          </div>
          <ul className="flex-1 space-y-2 overflow-y-auto p-3">
            {members.length === 0 ? (
              <li className="py-8 text-center text-sm text-slate-500">尚未添加成员，请从左侧勾选用户</li>
            ) : (
              members.map((m) => {
                const info = displayForMember(m.user_id);
                const busy = busyUserIds.has(m.user_id);
                return (
                  <li
                    key={m.id}
                    className="flex items-start gap-3 rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-700"
                  >
                    <MemberAvatar initial={info.initial} role={m.role} />
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                        {info.displayName}
                      </p>
                      <p className="truncate text-xs text-slate-500">{m.user_id}</p>
                      <div className="mt-2">
                        <RoleTagPicker
                          role={m.role}
                          disabled={busy || m.role === "owner"}
                          onChange={(next) => void updateRole(m.user_id, next)}
                        />
                      </div>
                    </div>
                    {m.role !== "owner" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeMember(m.user_id)}
                        className="shrink-0 text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                      >
                        移除
                      </button>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>

      {err ? <p className="mt-3 text-xs text-red-500">{err}</p> : null}
    </section>
  );
}
