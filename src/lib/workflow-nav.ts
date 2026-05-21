export type WorkflowNavItem = {
  href: string;
  label: string;
  shortLabel: string;
  description: string;
};

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
  },
  {
    href: "/knowledge",
    label: "知识库",
    shortLabel: "知识库",
    description: "配置知识范围并验证检索效果。",
  },
  {
    href: "/skills",
    label: "技能工坊",
    shortLabel: "技能工坊",
    description: "维护可用于任务执行的能力池。",
  },
  {
    href: "/settings",
    label: "用户设置",
    shortLabel: "设置",
    description: "用户身份、Hermes-agent MCP 工具白名单。",
  },
];

export function getWorkflowNavItem(pathname: string) {
  if (!pathname || pathname === "/") {
    return WORKFLOW_NAV_ITEMS[0];
  }
  return (
    WORKFLOW_NAV_ITEMS.find((item) =>
      item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
    ) ?? WORKFLOW_NAV_ITEMS[0]
  );
}
