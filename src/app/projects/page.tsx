"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";

interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "archived";
  deadline: string | null;
  background: string | null;
}

const statusColors: Record<string, string> = {
  active: "bg-blue-600",
  paused: "bg-yellow-500",
  completed: "bg-green-600",
  archived: "bg-slate-500",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Project[]>("/projects/")
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold">项目管理</h1>
          <Link
            href="/projects/new"
            className="px-5 py-2.5 bg-blue-600 rounded-lg hover:bg-blue-500 transition text-white font-medium"
          >
            + 新建项目
          </Link>
        </div>

        {loading && (
          <p className="text-slate-400 text-center py-12">加载中...</p>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300">
            加载失败: {error}
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <p className="text-slate-400 text-center py-12">暂无项目</p>
        )}

        {!loading && !error && projects.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="block bg-slate-800/60 border border-slate-700 rounded-xl p-5 hover:bg-slate-700/60 hover:border-slate-600 transition"
              >
                <div className="flex items-start justify-between mb-3">
                  <h2 className="text-xl font-semibold text-white">
                    {project.name}
                  </h2>
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-medium text-white ${
                      statusColors[project.status] ?? "bg-slate-500"
                    }`}
                  >
                    {project.status}
                  </span>
                </div>
                <p className="text-slate-400 text-sm mb-3 line-clamp-2">
                  {project.background || "暂无背景描述"}
                </p>
                <p className="text-slate-500 text-xs">
                  截止日期：{project.deadline || "未设置"}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
