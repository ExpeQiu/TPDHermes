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
    href: "/create",
    label: "场景编排",
    shortLabel: "场景编排",
    description: "定义任务边界、知识范围和期望输出。",
  },
  {
    href: "/chat",
    label: "编排协作",
    shortLabel: "编排协作",
    description: "围绕任务边界持续对话、执行和迭代。",
  },
  {
    href: "/workshop",
    label: "结果工坊",
    shortLabel: "结果工坊",
    description: "优化已有结果，或做定向生成。",
  },
  {
    href: "/knowledge",
    label: "知识策略",
    shortLabel: "知识策略",
    description: "配置知识范围并验证检索效果。",
  },
  {
    href: "/skills",
    label: "技能策略",
    shortLabel: "技能策略",
    description: "维护可用于任务执行的能力池。",
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
