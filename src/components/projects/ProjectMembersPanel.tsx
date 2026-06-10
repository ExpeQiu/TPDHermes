"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { PROJECT_ROLE_OPTIONS, type ProjectRole } from "@/lib/rbac";

interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  created_at: string;
  updated_at: string;
}

export default function ProjectMembersPanel({
  projectId,
  myRole,
}: {
  projectId: string;
  myRole?: string | null;
}) {
  const canManage = myRole === "owner";
  const [members, setMembers] = useState<ProjectMemberRow[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId || !canManage) return;
    try {
      const rows = await apiGet<ProjectMemberRow[]>(`/projects/${projectId}/members`);
      setMembers(rows);
      setErr("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载成员失败");
    }
  }, [canManage, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!canManage) {
    return myRole ? (
      <p className="text-xs text-slate-500">你在本项目中的角色：{myRole}</p>
    ) : null;
  }

  const addMember = async () => {
    const uid = userId.trim();
    if (!uid) return;
    setLoading(true);
    setErr("");
    try {
      await apiPost(`/projects/${projectId}/members`, { user_id: uid, role });
      setUserId("");
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "添加失败");
    } finally {
      setLoading(false);
    }
  };

  const updateRole = async (memberUserId: string, nextRole: ProjectRole) => {
    setErr("");
    try {
      await apiPatch(`/projects/${projectId}/members/${encodeURIComponent(memberUserId)}`, {
        role: nextRole,
      });
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "更新失败");
    }
  };

  const removeMember = async (memberUserId: string) => {
    setErr("");
    try {
      await apiDelete(`/projects/${projectId}/members/${encodeURIComponent(memberUserId)}`);
      await refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "移除失败");
    }
  };

  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">项目成员与 Role</h3>
      <p className="mt-1 text-xs text-slate-500">负责人可邀请成员并分配项目内角色（只读 / 编辑 / 负责人）。</p>

      <ul className="mt-4 space-y-2">
        {members.map((m) => (
          <li
            key={m.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
          >
            <code className="min-w-0 flex-1 truncate text-xs">{m.user_id}</code>
            <select
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-950"
              value={m.role}
              onChange={(e) => void updateRole(m.user_id, e.target.value as ProjectRole)}
              disabled={m.role === "owner"}
            >
              {PROJECT_ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {m.role !== "owner" && (
              <button
                type="button"
                className="text-xs text-red-600 hover:underline dark:text-red-400"
                onClick={() => void removeMember(m.user_id)}
              >
                移除
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          className="min-w-[12rem] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="成员 User ID"
        />
        <select
          className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectRole)}
        >
          {PROJECT_ROLE_OPTIONS.filter((o) => o.value !== "owner").map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={loading}
          onClick={() => void addMember()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-60"
        >
          添加成员
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
    </section>
  );
}
