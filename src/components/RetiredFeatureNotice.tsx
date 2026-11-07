import Link from "next/link";

export function RetiredFeatureNotice({ title }: { title: string }) {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 text-slate-900 dark:text-slate-100">
      <div className="max-w-md text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">已下线</p>
        <h1 className="mt-3 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm text-slate-500">该功能已下线。</p>
        <Link
          href="/"
          className="mt-6 inline-flex rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          返回首页
        </Link>
      </div>
    </main>
  );
}
