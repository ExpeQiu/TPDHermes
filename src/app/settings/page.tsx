"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { USER_ROLE_STORAGE_KEY } from "@/lib/api-headers";
import {
  FEISHU_SESSION_STORAGE_KEY,
  USER_ID_STORAGE_KEY,
  loadFeishuSessionFromStorage,
  loadUserIdFromStorage,
  normalizeUserId,
} from "@/lib/user-id";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

interface MeResponse {
  user_id: string;
  role: string;
  feishu_bound: boolean;
  name: string | null;
  avatar_url: string | null;
}

export default function SettingsPage() {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [err, setErr] = useState("");

  const refreshMe = useCallback(async () => {
    try {
      const m = await apiGet<MeResponse>("/me");
      setMe(m);
      setErr("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    setUserId(loadUserIdFromStorage().trim() || "default");
    if (typeof window !== "undefined") {
      setRole(window.localStorage.getItem(USER_ROLE_STORAGE_KEY)?.trim() || "tenant_admin");
    }
    refreshMe();
  }, [refreshMe]);

  const save = () => {
    if (typeof window === "undefined") return;
    const u = normalizeUserId(userId.trim() || "default");
    window.localStorage.setItem(USER_ID_STORAGE_KEY, u);
    window.localStorage.setItem(USER_ROLE_STORAGE_KEY, (role || "tenant_admin").trim() || "tenant_admin");
    setUserId(u);
    refreshMe();
  };

  return (
    <main className="min-h-screen bg-slate-950 p-4 text-slate-100 sm:p-8">
      <div className={CONTENT_MAX_CLASS}>
        <Link href="/" className="text-sm text-slate-400 hover:text-white">
          ← 返回首页
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">用户与身份</h1>
        <p className="mt-2 text-sm text-slate-400">
          本地 <code className="text-slate-300">user_id</code> 与 API 请求头{" "}
          <code className="text-slate-300">X-User-ID</code> 对齐；飞书登录后可改为{" "}
          <code className="text-slate-300">feishu:...</code>。
        </p>

        <div className="mt-8 max-w-lg space-y-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
          {me && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3 text-sm">
              <p>
                <span className="text-slate-500">服务端解析 ID：</span>
                <span className="text-slate-200">{me.user_id}</span>
              </p>
              <p className="mt-1">
                <span className="text-slate-500">角色：</span>
                {me.role}
                {me.feishu_bound ? " · 已绑定飞书会话" : ""}
              </p>
              {me.name && (
                <p className="mt-1 text-slate-400">
                  {me.name}
                  {me.avatar_url ? "（有头像）" : ""}
                </p>
              )}
            </div>
          )}

          <label className="block text-sm">
            <span className="text-slate-400">本地 User ID</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="default 或自定义 ID"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">X-User-Role（可选）</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="tenant_admin"
            />
          </label>
          <p className="text-xs text-slate-500">
            飞书会话 token 键：<code>{FEISHU_SESSION_STORAGE_KEY}</code>，当前
            {loadFeishuSessionFromStorage() ? "已设置" : "未设置"}。
          </p>
          {err && <p className="text-sm text-red-400">{err}</p>}
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
          >
            保存到本机
          </button>
        </div>
      </div>
    </main>
  );
}
