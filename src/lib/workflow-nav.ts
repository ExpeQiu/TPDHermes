import { isRetiredWorkflowHref } from "./retired-workflows";
import { isSystemAdminRole } from "./user-admin";

export type WorkflowNavItem = {
  href: string;
  label: string;
  shortLabel: string;
  description: string;
  /** @deprecated 使用 requiredFeature */
  adminOnly?: boolean;
  /** 默认仅系统管理员 / 平台管理员可见 */
  systemAdminOnly?: boolean;
  requiredFeature?: import("./rbac").FeatureKey;
  /** 覆盖默认 pathname 高亮规则 */
  matchActive?: (pathname: string) => boolean;
  /** 客户端解析跳转目标（如项目共创需带入最近项目） */
  resolveHref?: (scopeUserId: string) => string;
};

export function isCoCreateNavPath(pathname: string): boolean {
  return /\/projects\/[^/]+\/co-create(?:\/|$)/.test(pathname);
}

export function isBrainstormNavPath(pathname: string): boolean {
  return /\/projects\/[^/]+\/brainstorm(?:\/|$)/.test(pathname);
}

export function brainstormProjectStorageKey(scopeUserId: string): string {
  return `TPCharness-brainstorm-project:${scopeUserId}`;
}

export function resolveBrainstormNavHref(scopeUserId: string): string {
  if (typeof window === "undefined") return "/projects?entry=brainstorm";
  try {
    const saved = window.localStorage.getItem(brainstormProjectStorageKey(scopeUserId))?.trim();
    if (saved) return `/projects/${saved}/brainstorm`;
  } catch {
    // 读取失败时回退到项目列表
  }
  const coCreateHref = resolveCoCreateNavHref(scopeUserId);
  const projectId = coCreateHref.match(/^\/projects\/([^/]+)\/co-create$/)?.[1];
  if (projectId) return `/projects/${projectId}/brainstorm`;
  return "/projects?entry=brainstorm";
}

export function resolveCoCreateNavHref(scopeUserId: string): string {
  if (typeof window === "undefined") return "/projects?entry=co-create";
  try {
    const activeId = window.localStorage.getItem(`TPCharness-co-create-active:${scopeUserId}`);
    const raw = window.localStorage.getItem(`TPCharness-co-create-sessions:${scopeUserId}`);
    if (!raw) return "/projects?entry=co-create";
    const sessions = JSON.parse(raw) as { id?: string; selectedProjectId?: string }[];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return "/projects?entry=co-create";
    }
    const active = activeId
      ? sessions.find((session) => session.id === activeId)
      : sessions[sessions.length - 1];
    const projectId = active?.selectedProjectId?.trim();
    if (projectId) return `/projects/${projectId}/co-create`;
  } catch {
    // 解析失败时回退到项目列表
  }
  return "/projects?entry=co-create";
}

export const WORKFLOW_NAV_ITEMS: WorkflowNavItem[] = [
  {
    href: "/",
    label: "工作台首页",
    shortLabel: "首页",
    description: "总览工作流阶段与核心入口。",
  },
  {
    href: "/projects",
    label: "项目中心",
    shortLabel: "项目中心",
    description: "管理长期边界，并进入项目级任务入口。",
    matchActive: (pathname) =>
      pathname.startsWith("/projects") &&
      !isCoCreateNavPath(pathname) &&
      !isBrainstormNavPath(pathname),
  },
  {
    href: "/projects?entry=co-create",
    label: "项目共创",
    shortLabel: "项目共创",
    description: "项目成员与角色 Agent 一起讨论，不自动新建文档。",
    matchActive: isCoCreateNavPath,
    resolveHref: resolveCoCreateNavHref,
  },
  {
    href: "/projects?entry=brainstorm",
    label: "头脑风暴",
    shortLabel: "头脑风暴",
    description: "在项目内发起多角色圆桌讨论。",
    matchActive: isBrainstormNavPath,
    resolveHref: resolveBrainstormNavHref,
  },
  {
    href: "/chat",
    label: "对话创作",
    shortLabel: "对话创作",
    description: "在对话中澄清边界、执行与迭代产出。",
  },
  {
    href: "/workshop",
    label: "场景输出",
    shortLabel: "场景输出",
    description: "在项目与场景上下文中沉淀与优化输出物。",
    systemAdminOnly: true,
  },
  {
    href: "/studio",
    label: "场景创作",
    shortLabel: "场景创作",
    description: "按技能卡进入场景创作。当前接入技术卡提取与核对。",
  },
  {
    href: "/create",
    label: "场景编排",
    shortLabel: "场景编排",
    description: "定义任务边界、知识范围和期望输出。",
    adminOnly: true,
    systemAdminOnly: true,
    requiredFeature: "create",
  },
  {
    href: "/knowledge",
    label: "知识库",
    shortLabel: "知识库",
    description: "配置知识范围并验证检索效果。",
    adminOnly: true,
    systemAdminOnly: true,
    requiredFeature: "knowledge",
  },
  {
    href: "/skills",
    label: "技能工坊",
    shortLabel: "技能工坊",
    description: "维护可用于任务执行的能力池。",
    requiredFeature: "skills",
  },
  {
    href: "/ops/usage",
    label: "成长",
    shortLabel: "成长",
    description: "功能使用统计、学习中心、P-team 与 Roles。",
    requiredFeature: "ops",
    matchActive: (pathname) => pathname.startsWith("/ops"),
  },
  {
    href: "/settings",
    label: "配置",
    shortLabel: "配置",
    description: "运行配置、工作台 CLI、用户身份、MCP 与技能卡释放。",
    systemAdminOnly: true,
  },
];

function isWorkflowNavItemActive(item: WorkflowNavItem, pathname: string): boolean {
  if (item.matchActive) return item.matchActive(pathname);
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href.split("?")[0] ?? item.href);
}

export function getWorkflowNavItem(pathname: string) {
  if (!pathname || pathname === "/") {
    return WORKFLOW_NAV_ITEMS[0];
  }
  return (
    WORKFLOW_NAV_ITEMS.find((item) => isWorkflowNavItemActive(item, pathname)) ??
    WORKFLOW_NAV_ITEMS[0]
  );
}

export type WorkflowPageAccess = {
  features?: readonly string[] | null;
  platformRole?: string | null;
};

/** 与顶栏一致：未就绪或非管理员时隐藏管理员入口；其余按 requiredFeature 过滤。 */
export function isWorkflowPageAccessible(
  item: WorkflowNavItem,
  access: WorkflowPageAccess | null | undefined,
): boolean {
  if (isRetiredWorkflowHref(item.href)) return false;
  if (item.systemAdminOnly && !isSystemAdminRole(access?.platformRole)) return false;
  const features = access?.features;
  const restricted = Boolean(item.requiredFeature || item.adminOnly);
  if (!features) return !restricted;
  if (item.requiredFeature) return features.includes(item.requiredFeature);
  if (item.adminOnly) return features.includes("create") || features.includes("knowledge");
  return true;
}

export function accessibleWorkflowPages(
  access: WorkflowPageAccess | null | undefined,
): WorkflowNavItem[] {
  return WORKFLOW_NAV_ITEMS.filter((item) => isWorkflowPageAccessible(item, access));
}
