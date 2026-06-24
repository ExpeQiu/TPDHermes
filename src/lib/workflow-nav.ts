export type WorkflowNavItem = {
  href: string;
  label: string;
  shortLabel: string;
  description: string;
  /** @deprecated 使用 requiredFeature */
  adminOnly?: boolean;
  requiredFeature?: import("./rbac").FeatureKey;
  /** 覆盖默认 pathname 高亮规则 */
  matchActive?: (pathname: string) => boolean;
  /** 客户端解析跳转目标（如项目共创需带入最近项目） */
  resolveHref?: (scopeUserId: string) => string;
};

export function isCoCreateNavPath(pathname: string): boolean {
  return /\/projects\/[^/]+\/co-create(?:\/|$)/.test(pathname);
}

export function resolveCoCreateNavHref(scopeUserId: string): string {
  if (typeof window === "undefined") return "/projects?entry=co-create";
  try {
    const activeId = window.localStorage.getItem(`tphermes-co-create-active:${scopeUserId}`);
    const raw = window.localStorage.getItem(`tphermes-co-create-sessions:${scopeUserId}`);
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
      pathname.startsWith("/projects") && !isCoCreateNavPath(pathname),
  },
  {
    href: "/projects?entry=co-create",
    label: "项目共创",
    shortLabel: "项目共创",
    description: "基于项目文件的 Agent 协同工作台。",
    matchActive: isCoCreateNavPath,
    resolveHref: resolveCoCreateNavHref,
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
  },
  {
    href: "/create",
    label: "场景编排",
    shortLabel: "场景编排",
    description: "定义任务边界、知识范围和期望输出。",
    adminOnly: true,
    requiredFeature: "create",
  },
  {
    href: "/knowledge",
    label: "知识库",
    shortLabel: "知识库",
    description: "配置知识范围并验证检索效果。",
    adminOnly: true,
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
    label: "运维用量",
    shortLabel: "运维",
    description: "功能使用、对话与技能采纳统计（平台管理员）。",
    requiredFeature: "ops",
  },
  {
    href: "/settings",
    label: "用户设置",
    shortLabel: "设置",
    description: "用户身份、Hermes-agent MCP 工具白名单。",
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
