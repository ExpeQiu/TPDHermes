"use client";

/** 技能卡启动时的进度条。完成后由调用方换成工作台页面。 */
export function WorkbenchBoot({
  title,
  progress,
  message,
  failed,
  onRetry,
}: {
  title: string;
  progress: number;
  message?: string;
  failed?: boolean;
  onRetry?: () => void;
}) {
  const width = Math.max(6, Math.min(100, progress));
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-4 px-6">
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{title}</p>
      <div
        className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-label={title}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${failed ? "bg-amber-500" : "bg-blue-600"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <p className="max-w-md text-center text-xs leading-5 text-slate-500">{message || "正在准备本机工作台…"}</p>
      {failed && onRetry ? (
        <button type="button" onClick={onRetry} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
          重新启动
        </button>
      ) : null}
    </div>
  );
}
