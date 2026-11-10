"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { featuresForPlatformRole, fetchUserAccess, type PlatformRole, type UserAccessState } from "@/lib/rbac";
import { accessibleWorkflowPages } from "@/lib/workflow-nav";
import { isSystemAdminRole } from "@/lib/user-admin";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import McpManagementPanel from "@/components/settings/McpManagementPanel";
import RuntimeConfigPanel from "@/components/settings/RuntimeConfigPanel";
import CliCapabilitiesPanel from "@/components/settings/CliCapabilitiesPanel";
import UserGroupManagementPanel from "@/components/settings/UserGroupManagementPanel";
import { useThemeStore } from "@/lib/store";

type SettingsTab = "runtime" | "cli" | "theme" | "identity" | "mcp";

const SETTINGS_TABS: { id: SettingsTab; label: string; description: string }[] = [
  {
    id: "identity",
    label: "用户与身份",
    description: "选择用户，编辑资料与分组；右侧列出该分组可访问的页面。",
  },
  {
    id: "runtime",
    label: "运行配置",
    description:
      "查看当前进程的对话上游与调用名。绑定本机内核后，模型区读写该安装自己的配置文件。密钥不展示。",
  },
  {
    id: "cli",
    label: "工作台 CLI",
    description:
      "其他 Agent 凭接入 Token 通过 CLI 连接本系统，并执行已开放的指令。每个子功能可单独开关。",
  },
  {
    id: "mcp",
    label: "MCP 管理",
    description: "管理 Harness 的 MCP 服务。修改写入 Harness 的 config.yaml，需重启 Harness。",
  },
  { id: "theme", label: "风格", description: "切换界面配色，偏好保存在本机浏览器。" },
];

const THEME_OPTIONS: { value: "light" | "dark"; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function PageAccessPanel({ access }: { access: UserAccessState | null }) {
  const pages = useMemo(() => {
    if (!access) return [];
    return accessibleWorkflowPages({
      features: access.features.length
        ? access.features
        : featuresForPlatformRole(access.platform_role as PlatformRole),
      platformRole: access.platform_role,
    });
  }, [access]);

  return (
    <aside
      aria-label="权限管理"
      className="rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50"
    >
      <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">权限管理</h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {access
          ? `当前角色「${access.platform_role_label || access.platform_role}」可访问的页面`
          : "正在读取当前用户可访问的页面"}
      </p>
      {!access ? (
        <p className="mt-4 text-sm text-slate-500">正在读取权限…</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {pages.map((page) => (
            <li
              key={page.href}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/80"
            >
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{page.label}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{page.description}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function parseTab(raw: string | null): SettingsTab {
  if (raw === "external") return "mcp";
  if (
    raw === "runtime" ||
    raw === "cli" ||
    raw === "identity" ||
    raw === "mcp" ||
    raw === "theme"
  ) {
    return raw;
  }
  return "runtime";
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen p-4 sm:p-8">
          <div className={CONTENT_MAX_CLASS}>
            <p className="text-sm text-slate-500">加载配置…</p>
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

  const [access, setAccess] = useState<UserAccessState | null>(null);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const movedTab = searchParams.get("tab");

  useEffect(() => {
    if (movedTab === "pteam") router.replace("/ops/pteam");
    if (movedTab === "roles") router.replace("/ops/roles");
    if (movedTab === "studio-skills") router.replace("/ops/studio-skills");
  }, [movedTab, router]);

  const setActiveTab = (tab: SettingsTab) => {
    router.replace(`/settings?tab=${tab}`, { scroll: false });
  };

  useEffect(() => {
    void fetchUserAccess()
      .then(setAccess)
      .catch(() => setAccess(null));
  }, []);

  if (movedTab === "pteam" || movedTab === "roles" || movedTab === "studio-skills") {
    return (
      <main className="min-h-screen p-4 sm:p-8">
        <div className={CONTENT_MAX_CLASS}>
          <p className="text-sm text-slate-500">正在打开成长…</p>
        </div>
      </main>
    );
  }

  const canManageUserGroups = Boolean(access && isSystemAdminRole(access.platform_role));

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
        <h1 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white sm:text-4xl">配置</h1>

        <div
          role="tablist"
          aria-label="配置分类"
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

          {activeTab === "runtime" && <RuntimeConfigPanel />}

          {activeTab === "cli" && <CliCapabilitiesPanel />}

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

          {activeTab === "identity" &&
            (canManageUserGroups ? (
              <UserGroupManagementPanel enabled={canManageUserGroups} />
            ) : (
              <div className="mt-4">
                <PageAccessPanel access={access} />
              </div>
            ))}

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
