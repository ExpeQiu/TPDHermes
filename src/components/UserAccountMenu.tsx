"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_INITIAL_PASSWORD,
  fetchLocalSession,
  loadLocalProfile,
  loginLocalAccount,
  logoutLocalAccount,
  registerLocalAccount,
  reloadAfterAuth,
  type LocalAccountProfile,
} from "@/lib/local-account";

type Mode = "login" | "register";

export default function UserAccountMenu() {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("login");
  const [profile, setProfile] = useState<LocalAccountProfile | null>(null);
  const [username, setUsername] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [orgId, setOrgId] = useState("");
  const [password, setPassword] = useState(DEFAULT_INITIAL_PASSWORD);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProfile(loadLocalProfile());
    let cancelled = false;
    void fetchLocalSession().then((next) => {
      if (!cancelled) setProfile(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const initial = profile?.avatar_initial || profile?.display_name?.slice(0, 1) || "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next =
        mode === "register"
          ? await registerLocalAccount({
              username,
              employee_id: employeeId,
              org_id: orgId,
              password,
            })
          : await loginLocalAccount({ username, password });
      setProfile(next);
      setOpen(false);
      reloadAfterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
      console.warn("[local-auth] 提交失败", err);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError("");
    try {
      await logoutLocalAccount();
      setProfile(null);
      setOpen(false);
      reloadAfterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "退出失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="用户"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-700"
      >
        {initial ? (
          initial
        ) : (
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="currentColor">
            <path d="M12 12a4.2 4.2 0 1 0-4.2-4.2A4.2 4.2 0 0 0 12 12Zm0 2.1c-3.5 0-7.2 1.8-7.2 4.4v1.2h14.4v-1.2c0-2.6-3.7-4.4-7.2-4.4Z" />
          </svg>
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="用户信息"
          className="absolute right-0 z-50 mt-2 w-72 rounded-2xl border border-slate-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {profile ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                  {initial || "U"}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                    {profile.display_name || profile.username}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {profile.platform_role_label || "项目成员"}
                  </p>
                </div>
              </div>
              <dl className="space-y-1 text-xs text-slate-500">
                <div className="flex justify-between gap-3">
                  <dt>用户名</dt>
                  <dd className="truncate text-slate-800 dark:text-slate-200">{profile.username}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>工号</dt>
                  <dd className="truncate text-slate-800 dark:text-slate-200">
                    {profile.employee_id || "未填写"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>组织</dt>
                  <dd className="truncate text-slate-800 dark:text-slate-200">
                    {profile.org_id || "未填写"}
                  </dd>
                </div>
              </dl>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="button"
                onClick={() => void logout()}
                disabled={busy}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {busy ? "退出中…" : "退出"}
              </button>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={(event) => void submit(event)}>
              <div className="flex rounded-lg bg-slate-100 p-1 text-sm dark:bg-slate-800">
                <button
                  type="button"
                  className={`flex-1 rounded-md py-1.5 ${mode === "login" ? "bg-white font-medium text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white" : "text-slate-500"}`}
                  onClick={() => {
                    setMode("login");
                    setError("");
                  }}
                >
                  登录
                </button>
                <button
                  type="button"
                  className={`flex-1 rounded-md py-1.5 ${mode === "register" ? "bg-white font-medium text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white" : "text-slate-500"}`}
                  onClick={() => {
                    setMode("register");
                    setError("");
                  }}
                >
                  注册
                </button>
              </div>
              <label className="block text-xs text-slate-500">
                用户名
                <input
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              {mode === "register" && (
                <>
                  <label className="block text-xs text-slate-500">
                    工号
                    <input
                      required
                      value={employeeId}
                      onChange={(event) => setEmployeeId(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                  <label className="block text-xs text-slate-500">
                    组织
                    <input
                      required
                      value={orgId}
                      onChange={(event) => setOrgId(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                </>
              )}
              <label className="block text-xs text-slate-500">
                密码
                <input
                  required
                  type="password"
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                {mode === "register" && (
                  <span className="mt-1 block text-[11px] text-slate-400">初始密码 {DEFAULT_INITIAL_PASSWORD}</span>
                )}
              </label>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {busy ? "提交中…" : mode === "register" ? "注册" : "登录"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
