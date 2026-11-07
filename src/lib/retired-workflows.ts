/** 已下线的工作流页面。页眉、首页卡片与直达路由都读这里。 */
export const RETIRED_WORKFLOW_HREFS = ["/workshop", "/create"] as const;

export function isRetiredWorkflowHref(href: string | null | undefined): boolean {
  const path = (href ?? "").split("?")[0] ?? "";
  return (RETIRED_WORKFLOW_HREFS as readonly string[]).includes(path);
}
