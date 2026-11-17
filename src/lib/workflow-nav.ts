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
  return pathname === "/co-create" || /\/projects\/[^/]+\/co-create(?:\/|$)/.test(pathname);
}

export function isBrainstormNavPath(pathname: string): boolean {
  return /\/projects\/[^/]+\/brainstorm(?:\/|$)/.test(pathname);
}

export function isPromotionNavPath(pathname: string): boolean {
  return pathname === "/promotion" || /\/projects\/[^/]+\/promotion(?:\/|$)/.test(pathname);
}

export function projectIdFromPath(pathname: string): string | null {
  const id = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  if (!id || id === "new") return null;
  return id;
}

export function resolveTechIpNavHref(scopeUserId: string): string {
  if (typeof window === "undefined") return "/promotion";
  const current = projectIdFromPath(window.location.pathname);
  if (current) return `/projects/${current}/promotion?choose=1`;
  const brainstormHref = resolveBrainstormNavHref(scopeUserId);
  const fromBrainstorm = brainstormHref.match(/^\/projects\/([^/]+)\/brainstorm$/)?.[1];
  if (fromBrainstorm) return `/projects/${fromBrainstorm}/promotion?choose=1`;
  const coCreateHref = resolveCoCreateNavHref(scopeUserId);
  const fromCoCreate = coCreateHref.match(/^\/projects\/([^/]+)\/co-create$/)?.[1];
  if (fromCoCreate) return `/projects/${fromCoCreate}/promotion?choose=1`;
  return "/promotion";
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

const CO_CREATE_ENTRY = "/co-create";

export function resolveCoCreateNavHref(scopeUserId: string): string {
  if (typeof window === "undefined") return CO_CREATE_ENTRY;
  try {
    const activeId = window.localStorage.getItem(`TPCharness-co-create-active:${scopeUserId}`);
    const raw = window.localStorage.getItem(`TPCharness-co-create-sessions:${scopeUserId}`);
    if (!raw) return CO_CREATE_ENTRY;
    const sessions = JSON.parse(raw) as { id?: string; selectedProjectId?: string }[];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      return CO_CREATE_ENTRY;
    }
    const active = activeId
      ? sessions.find((session) => session.id === activeId)
      : sessions[sessions.length - 1];
    const projectId = active?.selectedProjectId?.trim();
    if (projectId) return `/projects/${projectId}/co-create`;
  } catch {
    // 解析失败时进入共创入口，由入口页选择项目
  }
  return CO_CREATE_ENTRY;
}

/** 顶栏把三条创作入口收成一组，页面权限仍按单页判断。 */
export const CONTENT_CREATION_CENTER = {
  id: "content-creation",
  label: "内容创作中心",
  shortLabel: "内容创作中心",
  memberLabels: ["项目共创", "头脑风暴", "对话创作"],
} as const;

export type WorkflowNavGroup = {
  kind: "group";
  id: string;
  label: string;
  shortLabel: string;
  items: WorkflowNavItem[];
};

export type WorkflowNavEntry = { kind: "link"; item: WorkflowNavItem } | WorkflowNavGroup;

export function groupWorkflowNavEntries(items: WorkflowNavItem[]): WorkflowNavEntry[] {
  const members = new Set<string>(CONTENT_CREATION_CENTER.memberLabels);
  const grouped: WorkflowNavItem[] = [];
  const entries: WorkflowNavEntry[] = [];
  let inserted = false;
  for (const item of items) {
    if (members.has(item.label)) {
      grouped.push(item);
      if (!inserted) {
        entries.push({
          kind: "group",
          id: CONTENT_CREATION_CENTER.id,
          label: CONTENT_CREATION_CENTER.label,
          shortLabel: CONTENT_CREATION_CENTER.shortLabel,
          items: grouped,
        });
        inserted = true;
      }
      continue;
    }
    entries.push({ kind: "link", item });
  }
  return entries;
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
      !isBrainstormNavPath(pathname) &&
      !isPromotionNavPath(pathname),
  },
  {
    href: "/promotion",
    label: "快捷创作",
    shortLabel: "快捷创作",
    description: "进入当前项目的快捷创作。",
    matchActive: isPromotionNavPath,
    resolveHref: resolveTechIpNavHref,
  },
  {
    href: "/co-create",
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
    label: "媒体工作台",
    shortLabel: "媒体工作台",
    description: "按技能卡进入媒体工作台。当前接入技术卡、价值链、信息屋、主张证据、SpeechStudio、CutPot 和 FrameFlow。",
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
    href: "/ops/learning",
    label: "迭代成长",
    shortLabel: "迭代成长",
    description: "功能使用统计、学习中心、P-team、Roles 与技能卡。",
    requiredFeature: "ops",
    matchActive: (pathname) => pathname.startsWith("/ops"),
  },
  {
    href: "/settings",
    label: "配置",
    shortLabel: "配置",
    description: "运行配置、工作台 CLI、用户身份与 MCP。",
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
