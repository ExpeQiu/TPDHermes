"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch, apiGet, apiV1 } from "@/lib/api";

const USE_MOCK_FALLBACK = process.env.NEXT_PUBLIC_USE_MOCK_WORKSHOP === "true";

function mapApiSkillToUi(row: { id: string; name: string; description: string }): Skill {
  const pkg = row.name;
  let icon = "📦";
  if (pkg.includes("speech")) icon = "🎤";
  else if (pkg.includes("video")) icon = "🎬";
  else if (pkg.includes("a4")) icon = "📄";
  else if (pkg.includes("hello")) icon = "👋";
  let category = "文档";
  if (pkg.includes("email") || pkg.includes("social")) category = "文案";
  return {
    id: pkg,
    name: pkg.replace(/_/g, " "),
    description: row.description || pkg,
    icon,
    category,
  };
}

interface Skill {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
}

// Mock data — replace with API call when /skills endpoint is ready
const MOCK_SKILLS: Skill[] = [
  {
    id: "speech",
    name: "发言稿",
    description: "生成领导讲话、产品发布、技术分享等场景的正式发言稿",
    icon: "🎤",
    category: "文档",
  },
  {
    id: "video-script",
    name: "视频脚本",
    description: "生成短视频/宣传片的分镜脚本，包含旁白和画面描述",
    icon: "🎬",
    category: "文档",
  },
  {
    id: "a4-onepager",
    name: "A4一页纸",
    description: "单页精华文档，提炼核心信息，适合快速阅读和传播",
    icon: "📄",
    category: "文档",
  },
  {
    id: "article",
    name: "技术文章",
    description: "生成深度技术文章，适合公众号、技术博客发布",
    icon: "✍️",
    category: "文档",
  },
  {
    id: "social-post",
    name: "社交媒体文案",
    description: "生成微博、小红书、朋友圈等社交平台的短文案",
    icon: "📱",
    category: "文案",
  },
  {
    id: "email",
    name: "商务邮件",
    description: "生成专业商务邮件，支持多种场景和语气",
    icon: "📧",
    category: "文档",
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  文档: "文档类",
  文案: "文案类",
};

export default function WorkshopPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    title: "",
    background: "",
    keywords: "",
    tone: "专业",
    extra: "",
  });

  // ─── Generation state ───────────────────────────────────────────────────────
  type GenStatus = "idle" | "generating" | "done" | "error";
  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<Array<{ id: string; name: string; description: string }>>("/skills/")
      .then((rows) => {
        setSkills(rows.map(mapApiSkillToUi));
      })
      .catch(() => {
        if (USE_MOCK_FALLBACK) setSkills(MOCK_SKILLS);
        else setSkills([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, skill) => {
    if (!acc[skill.category]) acc[skill.category] = [];
    acc[skill.category].push(skill);
    return acc;
  }, {});

  const selected = skills.find((s) => s.id === selectedSkill);

  // Auto-scroll to bottom of output on new content
  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [output]);

  const buildContext = useCallback(() => ({
    title: form.title,
    background: form.background,
    keywords: form.keywords,
    tone: form.tone,
    extra: form.extra,
  }), [form]);

  const handleSubmit = useCallback(() => {
    if (!selectedSkill || !form.title) {
      alert("请选择模板类型并填写标题");
      return;
    }

    // Reset state
    setOutput("");
    setErrorMsg("");
    setGenStatus("generating");
    setCopied(false);

    // Abort any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const context = buildContext();

    fetch(apiV1("/ws/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_name: selectedSkill, context }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const process = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              if (buffer) setOutput((prev) => prev + buffer);
              setGenStatus((s) => (s === "generating" ? "done" : s));
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? ""; // keep incomplete line in buffer

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === "chunk") {
                  const content = typeof event.content === "string"
                    ? event.content
                    : JSON.stringify(event.content, null, 2);
                  setOutput((prev) => prev + content);
                } else if (event.type === "error") {
                  setErrorMsg(event.message);
                  setGenStatus("error");
                } else if (event.type === "done") {
                  setGenStatus("done");
                }
              } catch {
                // skip malformed SSE lines
              }
            }
            if (genStatus !== "error") process();
          }).catch(() => {});
        };
        process();
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setErrorMsg(err.message);
        setGenStatus("error");
      });
  }, [selectedSkill, form, buildContext]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Link href="/" className="text-slate-400 hover:text-white transition text-sm">
              ← 返回首页
            </Link>
          </div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold">输出工坊</h1>
          <p className="text-slate-400 mt-1">选择模板类型，填写关键信息，一键生成高质量内容</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Skill Selector */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-6">
              <h2 className="text-xl font-semibold mb-4">选择内容模板</h2>

              {loading && (
                <p className="text-slate-400 text-sm py-8 text-center">加载中...</p>
              )}

              {!loading &&
                Object.entries(grouped).map(([category, categorySkills]) => (
                  <div key={category} className="mb-5">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                      {CATEGORY_LABELS[category] ?? category}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {categorySkills.map((skill) => {
                        const isSelected = selectedSkill === skill.id;
                        return (
                          <button
                            key={skill.id}
                            onClick={() => setSelectedSkill(skill.id)}
                            className={`text-left p-4 rounded-lg border transition-all ${
                              isSelected
                                ? "bg-blue-600/20 border-blue-500 text-white"
                                : "bg-slate-700/40 border-slate-600 text-slate-300 hover:border-slate-500 hover:bg-slate-700/60"
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <span className="text-2xl mt-0.5">{skill.icon}</span>
                              <div>
                                <div className="font-medium text-sm">{skill.name}</div>
                                <div className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                                  {skill.description}
                                </div>
                              </div>
                            </div>
                            {isSelected && (
                              <div className="mt-3 flex items-center gap-1.5 text-blue-400 text-xs font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                                已选择
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Right: Form Panel */}
          <div className="space-y-5">
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-6">
              <h2 className="text-xl font-semibold mb-4">填写信息</h2>

              {!selected && (
                <p className="text-slate-500 text-sm text-center py-6">
                  请先在左侧选择一个模板
                </p>
              )}

              {selected && (
                <div className="space-y-4">
                  {/* Selected skill indicator */}
                  <div className="bg-blue-600/10 border border-blue-600/30 rounded-lg p-3 flex items-center gap-2">
                    <span className="text-lg">{selected.icon}</span>
                    <div>
                      <p className="text-xs text-blue-400">已选模板</p>
                      <p className="text-sm font-medium">{selected.name}</p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      内容标题 <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      placeholder="输入内容标题"
                      className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      背景描述
                    </label>
                    <textarea
                      value={form.background}
                      onChange={(e) => setForm({ ...form, background: e.target.value })}
                      placeholder="补充相关背景、上下文或特殊要求"
                      rows={3}
                      className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      关键词（逗号分隔）
                    </label>
                    <input
                      type="text"
                      value={form.keywords}
                      onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                      placeholder="例如：新能源、智能化、领先"
                      className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      文风语气
                    </label>
                    <select
                      value={form.tone}
                      onChange={(e) => setForm({ ...form, tone: e.target.value })}
                      className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition appearance-none cursor-pointer"
                    >
                      <option value="专业">专业严谨</option>
                      <option value="通俗">通俗易懂</option>
                      <option value="激励">激励鼓舞</option>
                      <option value="亲和">亲切友好</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">
                      补充说明
                    </label>
                    <textarea
                      value={form.extra}
                      onChange={(e) => setForm({ ...form, extra: e.target.value })}
                      placeholder="任何额外要求或参考信息"
                      rows={2}
                      className="w-full bg-slate-700/60 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
                    />
                  </div>

                  <button
                    onClick={handleSubmit}
                    disabled={genStatus === "generating"}
                    className={`w-full mt-2 py-2.5 rounded-lg text-white font-medium transition ${
                      genStatus === "generating"
                        ? "bg-slate-600 cursor-not-allowed"
                        : "bg-blue-600 hover:bg-blue-500"
                    }`}
                  >
                    {genStatus === "generating" ? "生成中…" : "开始生成"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── Output Preview ─────────────────────────────────────────────── */}
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">生成结果</h2>
            <div className="flex items-center gap-3">
              {/* Status badge */}
              {genStatus === "generating" && (
                <span className="flex items-center gap-1.5 text-sm text-blue-400">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  生成中
                </span>
              )}
              {genStatus === "done" && (
                <span className="flex items-center gap-1.5 text-sm text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  完成
                </span>
              )}
              {genStatus === "error" && (
                <span className="flex items-center gap-1.5 text-sm text-red-400">
                  <span className="w-2 h-2 rounded-full bg-red-400" />
                  错误
                </span>
              )}
              {/* Copy button */}
              {output && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(output).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                    copied
                      ? "border-green-500/50 bg-green-500/10 text-green-400"
                      : "border-slate-600 bg-slate-700/60 text-slate-300 hover:bg-slate-700 hover:text-white"
                  }`}
                >
                  {copied ? "✓ 已复制" : "复制全文"}
                </button>
              )}
            </div>
          </div>

          {/* Output area */}
          <div className="bg-slate-900/60 border border-slate-700 rounded-lg p-4 min-h-48 max-h-96 overflow-y-auto">
            {genStatus === "idle" && !output && (
              <p className="text-slate-600 text-sm italic">填写左侧信息并点击「开始生成」后，结果将显示在此处</p>
            )}
            {genStatus === "generating" && !output && (
              <p className="text-slate-400 text-sm">正在生成，请稍候…</p>
            )}
            {errorMsg && (
              <p className="text-red-400 text-sm">❌ {errorMsg}</p>
            )}
            {output && (
              <pre className="whitespace-pre-wrap text-sm text-slate-200 leading-relaxed font-mono">
                {output}
                {genStatus === "generating" && (
                  <span className="inline-block w-2 h-4 bg-blue-400 ml-1 align-middle animate-pulse" />
                )}
              </pre>
            )}
            <div ref={outputEndRef} />
          </div>
        </div>
      </div>
    </main>
  );
}
