"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiV1 } from "@/lib/api";
import type { ProjectRecord, TaskExecuteBody } from "@/lib/chat-context";

const USE_MOCK_FALLBACK = process.env.NEXT_PUBLIC_USE_MOCK_WORKSHOP === "true";

type GenStatus = "idle" | "generating" | "done" | "error";
type WorkshopMode = "refine" | "generate";

interface Skill {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
}

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
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
          加载结果工坊...
        </div>
      }
    >
      <WorkshopPageInner />
    </Suspense>
  );
}

function WorkshopPageInner() {
  const searchParams = useSearchParams();
  const projectFromUrl = searchParams?.get("project") ?? "";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<WorkshopMode>("refine");
  const [form, setForm] = useState({
    title: "",
    objective: "",
    background: "",
    sourceMaterial: "",
    keywords: "",
    tone: "专业",
    extra: "",
  });
  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (projectFromUrl) {
      setSelectedProjectId(projectFromUrl);
    }
  }, [projectFromUrl]);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      apiGet<Array<{ id: string; name: string; description: string }>>("/skills/"),
      apiGet<ProjectRecord[]>("/projects/"),
    ])
      .then(([skillsRes, projectsRes]) => {
        if (skillsRes.status === "fulfilled") {
          setSkills(skillsRes.value.map(mapApiSkillToUi));
        } else if (USE_MOCK_FALLBACK) {
          setSkills(MOCK_SKILLS);
        } else {
          setSkills([]);
        }

        if (projectsRes.status === "fulfilled") {
          setProjects(projectsRes.value);
        } else {
          setProjects([]);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const grouped = skills.reduce<Record<string, Skill[]>>((acc, skill) => {
    if (!acc[skill.category]) acc[skill.category] = [];
    acc[skill.category].push(skill);
    return acc;
  }, {});

  const selectedSkillMeta = skills.find((s) => s.id === selectedSkill);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [output]);

  const buildContext = useCallback(
    () => ({
      mode,
      title: form.title,
      objective: form.objective,
      background: form.background,
      source_material: form.sourceMaterial,
      keywords: form.keywords,
      tone: form.tone,
      extra: form.extra,
      project_name: selectedProject?.name ?? null,
    }),
    [form, mode, selectedProject?.name],
  );

  const summaryItems = useMemo(
    () => [
      { label: "工作模式", value: mode === "refine" ? "结果优化" : "定向生成" },
      { label: "关联项目", value: selectedProject?.name ?? "未绑定项目" },
      { label: "技能策略", value: selectedSkillMeta?.name ?? "未选择技能" },
      {
        label: "任务目标",
        value:
          form.objective.trim() ||
          (mode === "refine" ? "对已有内容继续优化和重写" : "基于要点直接生成内容"),
      },
    ],
    [form.objective, mode, selectedProject?.name, selectedSkillMeta?.name],
  );

  const handleSubmit = useCallback(() => {
    if (!selectedSkill || !form.title.trim()) {
      alert("请选择技能模板并填写任务标题");
      return;
    }

    setOutput("");
    setErrorMsg("");
    setGenStatus("generating");
    setCopied(false);

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const body: TaskExecuteBody = {
      entrypoint: "workshop",
      project_id: selectedProjectId || null,
      scenario_id: mode === "refine" ? "refine" : "general",
      user_message: JSON.stringify({ skill: selectedSkill, ...buildContext() }),
      stream: true,
      overrides: {
        skills: {
          mode: "manual_only",
          allowed: [selectedSkill],
          allow_agent_free_choice: false,
        },
      },
    };

    fetch(apiV1("/tasks/execute"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

        function parseOpenAiDelta(data: string): string {
          if (!data || data === "[DONE]") return "";
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (parsed.error) return "";
            const choices = parsed.choices as Record<string, unknown>[] | undefined;
            const c0 = choices?.[0] as Record<string, unknown> | undefined;
            const delta = c0?.delta as Record<string, unknown> | undefined;
            const dc = delta?.content;
            if (typeof dc === "string") return dc;
            const msg = c0?.message as Record<string, unknown> | undefined;
            const mc = msg?.content;
            if (typeof mc === "string") return mc;
            if (parsed.tphermes_task) return "";
          } catch {
            return "";
          }
          return "";
        }

        const pump = (): void => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) {
                setGenStatus((s) => (s === "generating" ? "done" : s));
                return;
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const raw = line.slice(6).trim();
                try {
                  const event = JSON.parse(raw) as Record<string, unknown>;
                  if (event.error) {
                    const msg =
                      typeof (event.error as { message?: string })?.message === "string"
                        ? (event.error as { message: string }).message
                        : JSON.stringify(event.error);
                    setErrorMsg(msg);
                    setGenStatus("error");
                    return;
                  }
                } catch {
                  // ignore malformed chunk
                }
                const chunk = parseOpenAiDelta(raw);
                if (chunk) setOutput((prev) => prev + chunk);
              }
              setGenStatus((s) => (s === "error" ? s : "generating"));
              pump();
            })
            .catch(() => {
              setGenStatus("error");
            });
        };
        pump();
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setErrorMsg(err.message);
        setGenStatus("error");
      });
  }, [buildContext, form.title, mode, selectedProjectId, selectedSkill]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Link href="/" className="text-sm text-slate-400 transition hover:text-white">
              ← 返回首页
            </Link>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            结果工坊
          </div>
          <h1 className="mt-4 text-3xl font-bold sm:text-4xl">结果优化与定向生成</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
            工坊不再只是单次生成器，而是承接工作流后段的定向优化页面。你可以绑定项目、指定技能，并围绕已有材料继续打磨。
          </p>
        </div>

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          {summaryItems.map((item) => (
            <SummaryCard key={item.label} label={item.label} value={item.value} />
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 1</p>
                  <h2 className="mt-2 text-xl font-semibold">选择结果处理模式</h2>
                </div>
                <span className="text-xs text-slate-500">工作流后段</span>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                <ModeCard
                  active={mode === "refine"}
                  title="结果优化"
                  desc="适合已有初稿、旧版本或需重写的内容，强调润色、重构与增强。"
                  onClick={() => setMode("refine")}
                />
                <ModeCard
                  active={mode === "generate"}
                  title="定向生成"
                  desc="适合已有目标与约束，但还没有成稿的情况，强调定向产出。"
                  onClick={() => setMode("generate")}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 2</p>
                  <h2 className="mt-2 text-xl font-semibold">选择技能模板</h2>
                </div>
                <span className="text-xs text-slate-500">
                  {loading ? "加载中..." : `共 ${skills.length} 个技能`}
                </span>
              </div>

              {loading && <p className="py-8 text-center text-sm text-slate-400">正在加载技能与项目...</p>}

              {!loading &&
                Object.entries(grouped).map(([category, categorySkills]) => (
                  <div key={category} className="mt-5">
                    <p className="mb-2 text-xs uppercase tracking-wider text-slate-500">
                      {CATEGORY_LABELS[category] ?? category}
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {categorySkills.map((skill) => {
                        const active = selectedSkill === skill.id;
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => setSelectedSkill(skill.id)}
                            className={`rounded-2xl border p-4 text-left transition ${
                              active
                                ? "border-blue-500 bg-blue-500/10"
                                : "border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/70"
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 text-2xl">{skill.icon}</span>
                              <div>
                                <div className="text-sm font-medium text-white">{skill.name}</div>
                                <div className="mt-1 text-xs leading-relaxed text-slate-400">
                                  {skill.description}
                                </div>
                              </div>
                            </div>
                            {active && (
                              <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-blue-300">
                                <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                                当前执行模板
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

          <aside className="space-y-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 3</p>
              <h2 className="mt-2 text-xl font-semibold">设置任务</h2>

              <div className="mt-5 space-y-4">
                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">关联项目</span>
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500"
                  >
                    <option value="">暂不绑定项目</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">任务标题</span>
                  <input
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="例如：客户方案一页纸优化版"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">任务目标</span>
                  <input
                    value={form.objective}
                    onChange={(e) => setForm({ ...form, objective: e.target.value })}
                    placeholder={mode === "refine" ? "说明本次希望优化什么" : "说明本次要生成什么"}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">背景与边界</span>
                  <textarea
                    value={form.background}
                    onChange={(e) => setForm({ ...form, background: e.target.value })}
                    rows={4}
                    placeholder="补充背景、使用场景、目标受众、不得遗漏的信息等"
                    className="w-full rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">
                    {mode === "refine" ? "待优化内容" : "可参考素材"}
                  </span>
                  <textarea
                    value={form.sourceMaterial}
                    onChange={(e) => setForm({ ...form, sourceMaterial: e.target.value })}
                    rows={6}
                    placeholder={
                      mode === "refine"
                        ? "粘贴已有稿件、历史版本或要重写的文本"
                        : "粘贴提纲、素材、要点或输入草稿"
                    }
                    className="w-full rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block space-y-2 text-sm">
                    <span className="text-slate-300">关键词</span>
                    <input
                      value={form.keywords}
                      onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                      placeholder="例如：智能座舱、降本增效、客户沟通"
                      className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                    />
                  </label>

                  <label className="block space-y-2 text-sm">
                    <span className="text-slate-300">文风语气</span>
                    <select
                      value={form.tone}
                      onChange={(e) => setForm({ ...form, tone: e.target.value })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500"
                    >
                      <option value="专业">专业严谨</option>
                      <option value="通俗">通俗易懂</option>
                      <option value="激励">激励鼓舞</option>
                      <option value="亲和">亲切友好</option>
                    </select>
                  </label>
                </div>

                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">补充要求</span>
                  <textarea
                    value={form.extra}
                    onChange={(e) => setForm({ ...form, extra: e.target.value })}
                    rows={3}
                    placeholder="例如：保留原有结构、补足案例、控制字数、避免营销口吻"
                    className="w-full rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={genStatus === "generating"}
                  className={`w-full rounded-2xl px-5 py-3 text-sm font-medium transition ${
                    genStatus === "generating"
                      ? "cursor-not-allowed bg-slate-700 text-slate-500"
                      : "bg-blue-600 text-white hover:bg-blue-500"
                  }`}
                >
                  {genStatus === "generating" ? "执行中…" : mode === "refine" ? "开始优化" : "开始生成"}
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Workflow Note</p>
              <h2 className="mt-2 text-xl font-semibold">当前定位</h2>
              <div className="mt-4 space-y-3 text-sm leading-relaxed text-slate-400">
                <p>工坊承接工作流后段，更适合基于明确目标和已知素材做结果打磨。</p>
                <p>如果你还在定义任务边界，优先从“场景编排”页进入；如果要继续追问和协作，则进入对话页。</p>
                <p>当前仍复用既有 `tasks/execute` 执行接口，后续可继续增强为真正的结果工作台。</p>
              </div>
            </div>
          </aside>
        </section>

        <section className="mt-6 rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">执行结果</h2>
            <div className="flex items-center gap-3">
              {genStatus === "generating" && (
                <span className="flex items-center gap-1.5 text-sm text-blue-400">
                  <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                  执行中
                </span>
              )}
              {genStatus === "done" && (
                <span className="flex items-center gap-1.5 text-sm text-green-400">
                  <span className="h-2 w-2 rounded-full bg-green-400" />
                  完成
                </span>
              )}
              {genStatus === "error" && (
                <span className="flex items-center gap-1.5 text-sm text-red-400">
                  <span className="h-2 w-2 rounded-full bg-red-400" />
                  错误
                </span>
              )}
              {output && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(output).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
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

          <div className="min-h-72 max-h-[32rem] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/60 p-5">
            {genStatus === "idle" && !output && (
              <p className="text-sm italic text-slate-500">
                完成上方设置后点击开始执行，结果会在这里持续流式更新。
              </p>
            )}
            {genStatus === "generating" && !output && (
              <p className="text-sm text-slate-400">正在执行，请稍候…</p>
            )}
            {errorMsg && <p className="text-sm text-red-400">❌ {errorMsg}</p>}
            {output && (
              <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-200">
                {output}
                {genStatus === "generating" && (
                  <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-blue-400 align-middle" />
                )}
              </pre>
            )}
            <div ref={outputEndRef} />
          </div>
        </section>
      </div>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-sm font-medium leading-relaxed text-white">{value}</p>
    </div>
  );
}

function ModeCard({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-2xl border p-5 text-left transition ${
        active
          ? "border-blue-500 bg-blue-500/10"
          : "border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/70"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-white">{title}</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
        </div>
        <span
          className={`mt-1 h-2.5 w-2.5 rounded-full ${active ? "bg-blue-400" : "bg-slate-600"}`}
          aria-hidden
        />
      </div>
    </button>
  );
}
