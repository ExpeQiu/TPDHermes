/** 主内容区最大宽度（与 GlobalWorkflowNav 内层对齐） */
export const CONTENT_MAX_CLASS =
  "mx-auto w-full max-w-[min(96rem,calc(100vw-2rem))]";

/** 顶栏内层：最大宽度 + 与页面主区一致的横向 gutter */
export const GLOBAL_NAV_INNER_CLASS = `${CONTENT_MAX_CLASS} px-4 py-3 sm:px-6 md:px-8`;

/** 全站页面主容器（浅/深渐变背景） */
export const PAGE_MAIN_CLASS =
  "min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white";

/** 全站 loading / 占位容器 */
export const PAGE_LOADING_CLASS =
  "flex min-h-screen items-center justify-center text-sm text-slate-500 dark:text-slate-400";
