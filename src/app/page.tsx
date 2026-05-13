import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white flex flex-col items-center justify-center p-8">
      <h1 className="text-5xl font-bold mb-4">TPDHermes</h1>
      <p className="text-xl text-slate-300 mb-8">技术推广文档智能生成平台</p>
      <div className="flex gap-4 flex-wrap justify-center">
        <Link href="/projects" className="px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-500 transition">
          项目管理
        </Link>
        <Link href="/workspace" className="px-6 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition">
          输出工坊
        </Link>
        <Link href="/chat" className="px-6 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition">
          💬 对话
        </Link>
        <Link href="/create" className="px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-500 transition">
          ⚡ 快速创作
        </Link>
        <Link href="/skills" className="px-6 py-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition">
          📦 Skills
        </Link>
      </div>
    </main>
  );
}
