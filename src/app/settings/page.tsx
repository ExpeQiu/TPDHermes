"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet } from "@/lib/api";
import { USER_ROLE_STORAGE_KEY } from "@/lib/rbac";
import {
  FEISHU_SESSION_STORAGE_KEY,
  USER_ID_STORAGE_KEY,
  ensureDerivedUserId,
  fetchDerivedUserId,
  getEffectiveUserIdSync,
  loadFeishuSessionFromStorage,
  loadUserIdFromStorage,
  normalizeUserId,
} from "@/lib/user-id";
import {
  adoptServerUnifiedUserIdIfNeeded,
  fetchServerIdentity,
  generateUnifiedUserId,
  saveUnifiedUserIdLocally,
  syncUnifiedUserIdToServer,
  type UserIdentityState,
} from "@/lib/user-identity-sync";
import {
  PLATFORM_ROLE_OPTIONS,
  fetchUserAccess,
  syncPlatformRoleToServer,
  type PlatformRole,
  type UserAccessState,
} from "@/lib/rbac";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import McpManagementPanel from "@/components/settings/McpManagementPanel";
import { useThemeStore } from "@/lib/store";

interface MeResponse {
  user_id: string;
  role: string;
  platform_role?: string;
  is_global_admin?: boolean;
  feishu_bound: boolean;
  name: string | null;
  avatar_url: string | null;
}

type SettingsTab = "theme" | "identity" | "mcp";

const SETTINGS_TABS: { id: SettingsTab; label: string; description: string }[] = [
  {
    id: "identity",
    label: "用户与身份",
    description:
      "统一 User ID 用于跨 PC 同步对话与场景记录；飞书登录自动绑定 feishu:*，也可生成或填写自定义 ID。",
  },
  {
    id: "mcp",
    label: "MCP 管理",
    description:
      "管理 Hermes-agent 可调用的 MCP 服务与工具白名单；配置写入 deploy/hermes-agent/config.yaml，修改后需重启 hermes-agent。",
  },
  { id: "theme", label: "风格", description: "切换界面配色，偏好保存在本机浏览器。" },
];

const THEME_OPTIONS: { value: "light" | "dark"; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function parseTab(raw: string | null): SettingsTab {
  if (raw === "identity" || raw === "mcp" || raw === "theme") return raw;
  return "identity";
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen p-4 sm:p-8">
          <div className={CONTENT_MAX_CLASS}>
            <p className="text-sm text-slate-500">加载设置…</p>
          </div>
        </main>
      }
    >
      <SettingsPageContent />
    </Suspense>
  );
}

function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseTab(searchParams.get("tab"));

  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<PlatformRole>("tenant_admin");
  const [access, setAccess] = useState<UserAccessState | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [identity, setIdentity] = useState<UserIdentityState | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const setActiveTab = (tab: SettingsTab) => {
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  };

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
    void adoptServerUnifiedUserIdIfNeeded().then((adopted) => {
      const stored = (adopted || loadUserIdFromStorage()).trim();
      if (stored) {
        setUserId(stored);
      } else {
        void fetchDerivedUserId()
          .then((id) => setUserId(id))
          .catch(() => setUserId(getEffectiveUserIdSync()));
      }
    });
    void fetchUserAccess()
      .then((a) => {
        setAccess(a);
        setRole(a.platform_role);
      })
      .catch(() => {
        if (typeof window !== "undefined") {
          const cached = window.localStorage.getItem(USER_ROLE_STORAGE_KEY)?.trim();
          if (cached === "tenant_admin" || cached === "tenant_editor" || cached === "tenant_viewer" || cached === "platform_admin") {
            setRole(cached);
          }
        }
      });
    refreshMe();
    void fetchServerIdentity()
      .then(setIdentity)
      .catch(() => setIdentity(null));
  }, [refreshMe]);

  const save = async () => {
    if (typeof window === "undefined") return;
    setSaving(true);
    setErr("");
    try {
      const raw = userId.trim();
      const u = raw ? normalizeUserId(raw) : await ensureDerivedUserId();
      saveUnifiedUserIdLocally(u);
      const platformRole = (role || "tenant_admin") as PlatformRole;
      window.localStorage.setItem(USER_ROLE_STORAGE_KEY, platformRole);
      setUserId(u);
      const synced = await syncUnifiedUserIdToServer(u);
      setIdentity(synced);
      const nextAccess = await syncPlatformRoleToServer(platformRole);
      setAccess(nextAccess);
      setRole(nextAccess.platform_role);
      await refreshMe();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateUserId = async () => {
    setErr("");
    try {
      const generated = await generateUnifiedUserId();
      setUserId(generated);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "生成失败");
    }
  };

  const currentTab = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  return (
    <main className="min-h-screen p-4 sm:p-8">
      <div className={CONTENT_MAX_CLASS}>
        <Link
          href="/"
          className="text-sm text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
        >
          ← 返回首页
        </Link>
        <h1 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white sm:text-4xl">设置</h1>

        <div
          role="tablist"
          aria-label="设置分类"
          className="mt-8 flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800"
        >
          {SETTINGS_TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`settings-panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={`-mb-px rounded-t-lg px-4 py-2.5 text-sm font-medium transition ${
                  active
                    ? "border border-b-transparent border-slate-200 bg-white text-slate-900 dark:border-slate-800 dark:bg-slate-900/50 dark:text-white"
                    : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <section
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          className="mt-6"
        >
          <p className="text-sm text-slate-500 dark:text-slate-400">{currentTab.description}</p>

          {activeTab === "theme" && (
            <div className="mt-4 max-w-lg">
              <div className="grid grid-cols-2 gap-3">
                {THEME_OPTIONS.map((opt) => {
                  const active = theme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTheme(opt.value)}
                      aria-pressed={active}
                      className={`rounded-2xl border p-4 text-left transition ${
                        active
                          ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/30"
                          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-slate-700"
                      }`}
                    >
                      <span
                        className={`mb-3 block h-10 rounded-lg border ${
                          opt.value === "light"
                            ? "border-slate-200 bg-gradient-to-br from-white to-slate-100"
                            : "border-slate-300 dark:border-slate-700 bg-gradient-to-br from-slate-900 to-slate-950"
                        }`}
                      />
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {opt.label}
                        {active ? "（当前）" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === "identity" && (
            <div className="mt-4 max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
              {me && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900/80">
                  <p>
                    <span className="text-slate-500">服务端解析 ID：</span>
                    <span className="text-slate-800 dark:text-slate-200">{me.user_id}</span>
                  </p>
                  <p className="mt-1">
                    <span className="text-slate-500">角色：</span>
                    {me.role}
                    {me.feishu_bound ? " · 已绑定飞书会话" : ""}
                  </p>
                  {me.name && (
                    <p className="mt-1 text-slate-600 dark:text-slate-400">
                      {me.name}
                      {me.avatar_url ? "（有头像）" : ""}
                    </p>
                  )}
                </div>
              )}

              {identity && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-200">
                  <p>
                    云端统一 ID：<span className="font-medium">{identity.unified_user_id}</span>
                    （{identity.source === "feishu" ? "飞书" : identity.source === "custom" ? "自定义" : "匿名"}）
                  </p>
                  <p className="mt-1 text-blue-800/80 dark:text-blue-300/80">
                    在其他 PC 填写相同 ID 并保存，即可同步对话与场景历史记录。
                  </p>
                </div>
              )}

              <label className="block text-sm">
                <span className="text-slate-500 dark:text-slate-400">统一 User ID</span>
                <div className="mt-1 flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    placeholder="user_… 或 feishu:…"
                  />
                  <button
                    type="button"
                    onClick={handleGenerateUserId}
                    className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    生成
                  </button>
                </div>
              </label>
              <label className="block text-sm">
                <span className="text-slate-500 dark:text-slate-400">平台 Role（功能入口权限）</span>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  value={role}
                  onChange={(e) => setRole(e.target.value as PlatformRole)}
                >
                  {PLATFORM_ROLE_OPTIONS.filter(
                    (opt) => opt.value !== "platform_admin" || access?.is_global_admin || me?.is_global_admin,
                  ).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.hint}
                    </option>
                  ))}
                </select>
              </label>
              {access && (
                <p className="text-xs text-slate-500">
                  已开放功能入口：{access.features.join(" · ")}
                </p>
              )}
              <p className="text-xs text-slate-500">
                保存后写入本机 <code>{USER_ID_STORAGE_KEY}</code> 并同步至服务端；历史对话按此 ID 隔离。
                飞书会话键 <code>{FEISHU_SESSION_STORAGE_KEY}</code>
                ，当前{loadFeishuSessionFromStorage() ? "已设置" : "未设置"}。
              </p>
              {err && <p className="text-sm text-red-500 dark:text-red-400">{err}</p>}
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {saving ? "保存中…" : "保存并同步"}
              </button>
            </div>
          )}

          {activeTab === "mcp" && (
            <div className="mt-4">
              <McpManagementPanel />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
