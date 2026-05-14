"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Feedback from "@/components/Feedback";
import { apiGet } from "@/lib/api";

interface ProjectOutput {
  id: string;
  skill_name: string;
  skill_icon: string;
  title: string;
  content: string;
  created_at: string;
  word_count: number;
  tags: string[];
}

interface Project {
  id: string;
  name: string;
  status: "active" | "paused" | "completed" | "archived";
  deadline: string | null;
  background: string | null;
  audience: string | null;
  constraints: unknown;
}

const statusColors: Record<string, string> = {
  active: "bg-blue-600",
  paused: "bg-yellow-500",
  completed: "bg-green-600",
  archived: "bg-slate-500",
};

const statusLabels: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
};

const MOCK_OUTPUTS: ProjectOutput[] = [
  {
    id: "out-1",
    skill_name: "发言稿生成器",
    skill_icon: "🎤",
    title: "新能源技术发布会领导致辞",
    content: "尊敬的各位嘉宾、媒体朋友们：\n\n今天，我们齐聚一堂，共同见证...",
    created_at: "2026-05-10 14:23",
    word_count: 1856,
    tags: ["发言稿", "发布会", "新能源"],
  },
  {
    id: "out-2",
    skill_name: "A4一页纸生成器",
    skill_icon: "📄",
    title: "2026款旗舰车型产品一页纸",
    content: "# 2026款旗舰车型核心卖点\n\n## 一、产品定位\n...",
    created_at: "2026-05-08 09:15",
    word_count: 892,
    tags: ["一页纸", "产品介绍"],
  },
  {
    id: "out-3",
    skill_name: "视频脚本生成器",
    skill_icon: "🎬",
    title: "品牌宣传片分镜脚本 v2",
    content: "[00:00-00:15] 开场航拍镜头，城市天际线...\n[00:15-00:30] 产品特写...",
    created_at: "2026-05-05 16:40",
    word_count: 1243,
    tags: ["视频脚本", "宣传片"],
  },
];

export default function ProjectDetailPage() {
  const { id } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [outputs, setOutputs] = useState<ProjectOutput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "outputs" | "feedback">("info");
  const [selectedOutput, setSelectedOutput] = useState<ProjectOutput | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<Project>(`/projects/${String(id)}`)
      .then((data) => {
        if (!cancelled) {
          setProject(data);
          setOutputs([]);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const totalWords = outputs.reduce((sum, o) => sum + o.word_count, 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/projects"
          className="inline-flex items-center text-slate-400 hover:text-white mb-6 transition text-sm"
        >
          ← 返回项目列表
        </Link>

        {loading && (
          <div className="space-y-4 animate-pulse">
            <div className="h-8 bg-slate-700 rounded w-1/2" />
            <div className="h-4 bg-slate-700 rounded w-full" />
            <div className="h-32 bg-slate-700 rounded" />
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300">
            加载失败: {error}
          </div>
        )}

        {project && (
          <>
            {/* Project header */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
              <div>
                <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold leading-tight">{project.name}</h1>
                <p className="text-slate-400 text-sm mt-1">项目 ID: #{project.id}</p>
              </div>
              <span
                className={`px-3 py-1 rounded-full text-xs sm:text-sm font-medium text-white self-start ${statusColors[project.status] ?? "bg-slate-500"}`}
              >
                {statusLabels[project.status] ?? project.status}
              </span>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 border-b border-slate-700 mb-6 overflow-x-auto">
              {[
                { key: "info", label: "项目信息" },
                { key: "outputs", label: "输出历史", badge: outputs.length },
                { key: "feedback", label: "用户反馈" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                    activeTab === tab.key
                      ? "border-blue-500 text-white"
                      : "border-transparent text-slate-400 hover:text-white hover:border-slate-600"
                  }`}
                >
                  {tab.label}
                  {tab.badge !== undefined && (
                    <span className="bg-blue-600/30 text-blue-400 text-xs px-1.5 py-0.5 rounded-full">
                      {tab.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* ─── Info Tab ─────────────────────────────────────────────── */}
            {activeTab === "info" && (
              <div className="space-y-4">
                <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 sm:p-6 space-y-4">
                  <InfoField label="项目背景">
                    <p className="text-slate-200 leading-relaxed">{project.background || "暂无描述"}</p>
                  </InfoField>

                  <InfoField label="目标受众">
                    <p className="text-slate-200">{project.audience || "未设置"}</p>
                  </InfoField>

                  <InfoField label="截止日期">
                    <p className="text-slate-200">{project.deadline || "未设置"}</p>
                  </InfoField>

                  <InfoField label="约束条件">
                    <pre className="bg-slate-900/60 rounded-lg p-4 text-slate-300 text-sm overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {project.constraints == null
                        ? "暂无约束条件"
                        : typeof project.constraints === "string"
                          ? project.constraints
                          : JSON.stringify(project.constraints, null, 2)}
                    </pre>
                  </InfoField>
                </div>

                <div className="flex gap-3">
                  <Link
                    href="/workshop"
                    className="flex-1 sm:flex-none px-5 py-2.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-center transition"
                  >
                    前往输出工坊 →
                  </Link>
                  <Link
                    href={`/projects/${id}/edit`}
                    className="px-5 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm font-medium text-center transition"
                  >
                    编辑项目
                  </Link>
                </div>
              </div>
            )}

            {/* ─── Outputs Tab ─────────────────────────────────────────── */}
            {activeTab === "outputs" && (
              <div className="space-y-4">
                {/* Stats */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4 text-center">
                    <p className="text-2xl sm:text-3xl font-bold">{outputs.length}</p>
                    <p className="text-xs text-slate-400 mt-0.5">总输出数</p>
                  </div>
                  <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4 text-center">
                    <p className="text-2xl sm:text-3xl font-bold">{totalWords.toLocaleString()}</p>
                    <p className="text-xs text-slate-400 mt-0.5">总字数</p>
                  </div>
                  <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4 text-center">
                    <p className="text-2xl sm:text-3xl font-bold">{project.status === "active" ? "进行中" : "已完成"}</p>
                    <p className="text-xs text-slate-400 mt-0.5">项目状态</p>
                  </div>
                </div>

                {outputs.length === 0 ? (
                  <div className="text-center py-16 text-slate-500">
                    <p className="text-4xl mb-3">📝</p>
                    <p>暂无输出记录</p>
                    <Link href="/workshop" className="text-blue-400 hover:text-blue-300 text-sm mt-2 inline-block">
                      前往输出工坊生成 →
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {outputs.map((output) => (
                      <div
                        key={output.id}
                        onClick={() => setSelectedOutput(output)}
                        className={`bg-slate-800/60 border rounded-xl p-4 cursor-pointer transition hover:border-slate-600 ${
                          selectedOutput?.id === output.id ? "border-blue-500" : "border-slate-700"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="text-2xl shrink-0">{output.skill_icon}</span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <h3 className="font-medium text-sm sm:text-base truncate">{output.title}</h3>
                                <span className="text-xs text-slate-500 shrink-0">{output.created_at}</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5 mb-2">
                                {output.tags.map((tag) => (
                                  <span key={tag} className="text-xs bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded">
                                    {tag}
                                  </span>
                                ))}
                                <span className="text-xs text-slate-500">{output.word_count.toLocaleString()} 字</span>
                              </div>
                              <p className="text-slate-400 text-xs line-clamp-2 leading-relaxed">
                                {output.content.slice(0, 120)}…
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Output Detail Modal */}
                {selectedOutput && (
                  <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
                      <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-700">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-2xl">{selectedOutput.skill_icon}</span>
                          <div className="min-w-0">
                            <h2 className="font-semibold text-sm sm:text-base truncate">{selectedOutput.title}</h2>
                            <p className="text-xs text-slate-500">{selectedOutput.skill_name} · {selectedOutput.created_at}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          <button
                            onClick={() => handleCopy(selectedOutput.content)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                              copied
                                ? "border-green-500/50 bg-green-500/10 text-green-400"
                                : "border-slate-600 bg-slate-700/60 text-slate-300 hover:bg-slate-700"
                            }`}
                          >
                            {copied ? "✓ 已复制" : "复制全文"}
                          </button>
                          <button
                            onClick={() => setSelectedOutput(null)}
                            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                        <pre className="whitespace-pre-wrap text-slate-200 text-sm leading-relaxed font-mono">
                          {selectedOutput.content}
                        </pre>
                      </div>
                      <div className="p-4 border-t border-slate-700 flex gap-3">
                        <Link
                          href="/workshop"
                          className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-center transition"
                        >
                          基于此优化
                        </Link>
                        <button
                          onClick={() => setSelectedOutput(null)}
                          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition"
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ─── Feedback Tab ─────────────────────────────────────────── */}
            {activeTab === "feedback" && (
              <Feedback
                skillId={`project-${id}`}
                skillName={project.name}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wider mb-2">{label}</p>
      {children}
    </div>
  );
}
