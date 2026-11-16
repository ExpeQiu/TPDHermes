/** 共创路由切换时的占位，避免列表页停在原处直到大包解析完。 */
export function CoCreateRouteSkeleton() {
  return (
    <div
      className="flex h-full min-h-0 bg-slate-100 dark:bg-slate-950"
      aria-busy="true"
      aria-label="正在打开项目共创"
    >
      <div className="w-56 shrink-0 animate-pulse border-r border-slate-200 bg-slate-200/80 dark:border-slate-800 dark:bg-slate-900/70" />
      <div className="min-w-0 flex-1 px-6 pt-16">
        <p className="text-center text-sm text-slate-500">正在打开项目共创…</p>
      </div>
      <div className="hidden w-[46%] min-w-[22rem] shrink-0 animate-pulse border-l border-slate-200 bg-slate-200/60 dark:border-slate-800 dark:bg-slate-900/50 sm:block" />
    </div>
  );
}
