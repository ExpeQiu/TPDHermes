"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiV1 } from "@/lib/api";
import type { ProjectRecord, TaskExecuteBody, TaskInputPayload } from "@/lib/chat-context";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { LOCAL_SCENARIO_IDS, SCENARIOS, type Scenario } from "@/lib/scenario-presets";

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

type ScenarioApiRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
};

type WorkshopScenarioOption = {
  id: string;
  name: string;
  versionLine: string;
};

/** 与 `GET /projects/{id}/outputs` 列表项一致（按 scenario_id 筛选） */
type ScenarioLinkedOutputRow = {
  id: string;
  title: string | null;
  summary: string | null;
  template_id: string | null;
  run_id: string | null;
  scenario_id?: string | null;
  status: string;
  created_at: string | null;
  content_preview: string;
};

function formatOutputTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
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
  const projectFromUrl =
    searchParams?.get("project_id") ?? searchParams?.get("project") ?? "";
  const scenarioFromUrl = searchParams?.get("scenario_id") ?? "";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [remoteScenarios, setRemoteScenarios] = useState<ScenarioApiRow[]>([]);
  const [loadingScenarios, setLoadingScenarios] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<WorkshopMode>("generate");
  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [scenarioLinkedOutputs, setScenarioLinkedOutputs] = useState<ScenarioLinkedOutputRow[]>([]);
  const [scenarioOutputsLoading, setScenarioOutputsLoading] = useState(false);

  useEffect(() => {
    if (projectFromUrl) {
      setSelectedProjectId(projectFromUrl);
    }
  }, [projectFromUrl]);

  useEffect(() => {
    setLoadingScenarios(true);
    apiGet<ScenarioApiRow[]>("/scenarios/")
      .then((rows) => setRemoteScenarios(rows))
      .catch(() => setRemoteScenarios([]))
      .finally(() => setLoadingScenarios(false));
  }, []);

  const remoteById = useMemo(
    () => new Map(remoteScenarios.map((r) => [r.id, r] as const)),
    [remoteScenarios],
  );

  const workshopScenarioOptions = useMemo((): WorkshopScenarioOption[] => {
    const extras = remoteScenarios.filter((r) => !LOCAL_SCENARIO_IDS.has(r.id));
    const presetOpts: WorkshopScenarioOption[] = SCENARIOS.map((s) => {
      const remote = remoteById.get(s.id);
      const versionLine = remote
        ? `${remote.status} · v${remote.version}`
        : "预设（未同步到服务端）";
      return { id: s.id, name: s.title, versionLine };
    });
    const extraOpts: WorkshopScenarioOption[] = extras.map((r) => ({
      id: r.id,
      name: r.name,
      versionLine: `${r.status} · v${r.version} · 服务端`,
    }));
    return [...presetOpts, ...extraOpts];
  }, [remoteScenarios, remoteById]);

  const selectedScenarioContext = useMemo(() => {
    if (!selectedScenarioId) return null;
    const preset: Scenario | null = SCENARIOS.find((s) => s.id === selectedScenarioId) ?? null;
    const remote = remoteById.get(selectedScenarioId);
    const opt = workshopScenarioOptions.find((o) => o.id === selectedScenarioId);
    const title = preset?.title ?? remote?.name ?? opt?.name ?? selectedScenarioId;
    const versionLine =
      opt?.versionLine ?? (remote ? `${remote.status} · v${remote.version}` : null);
    return { preset, remote, title, versionLine };
  }, [selectedScenarioId, remoteById, workshopScenarioOptions]);

  useEffect(() => {
    if (workshopScenarioOptions.length === 0) {
      setSelectedScenarioId("");
      return;
    }
    if (scenarioFromUrl && workshopScenarioOptions.some((o) => o.id === scenarioFromUrl)) {
      setSelectedScenarioId(scenarioFromUrl);
      return;
    }
    if (mode === "refine" && workshopScenarioOptions.some((o) => o.id === "refine")) {
      setSelectedScenarioId("refine");
      return;
    }
    if (selectedScenarioId && workshopScenarioOptions.some((o) => o.id === selectedScenarioId)) {
      return;
    }
    const first = workshopScenarioOptions[0];
    setSelectedScenarioId(first?.id ?? "");
  }, [workshopScenarioOptions, mode, scenarioFromUrl, selectedScenarioId]);

  useEffect(() => {
    if (!selectedProjectId || !selectedScenarioId) {
      setScenarioLinkedOutputs([]);
      setScenarioOutputsLoading(false);
      return;
    }
    let cancelled = false;
    setScenarioOutputsLoading(true);
    const qs = new URLSearchParams({ scenario_id: selectedScenarioId, limit: "40" });
    apiGet<ScenarioLinkedOutputRow[]>(`/projects/${selectedProjectId}/outputs?${qs.toString()}`)
      .then((rows) => {
        if (!cancelled) setScenarioLinkedOutputs(rows);
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[workshop] 场景关联输出列表加载失败", err);
        }
        if (!cancelled) setScenarioLinkedOutputs([]);
      })
      .finally(() => {
        if (!cancelled) setScenarioOutputsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, selectedScenarioId]);

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

  const derivedTaskTitle = useMemo(() => {
    const projectName = selectedProject?.name?.trim() || "项目";
    const scenarioName =
      workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "场景";
    const skillPart = selectedSkillMeta?.name ?? selectedSkill ?? "技能";
    return `${projectName} · ${scenarioName} · ${skillPart}`;
  }, [
    selectedProject?.name,
    workshopScenarioOptions,
    selectedScenarioId,
    selectedSkillMeta?.name,
    selectedSkill,
  ]);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [output]);

  const buildContext = useCallback(
    () => ({
      mode,
      title: derivedTaskTitle,
      project_name: selectedProject?.name ?? null,
    }),
    [derivedTaskTitle, mode, selectedProject?.name],
  );

  const summaryItems = useMemo(
    () => [
      { label: "工作模式", value: mode === "refine" ? "结果优化" : "定向生成" },
      { label: "关联项目", value: selectedProject?.name ?? "请先选择项目" },
      {
        label: "场景",
        value:
          workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "—",
      },
      { label: "技能策略", value: selectedSkillMeta?.name ?? "未选择技能" },
    ],
    [
      mode,
      selectedProject?.name,
      selectedSkillMeta?.name,
      workshopScenarioOptions,
      selectedScenarioId,
    ],
  );

  const agentExecutePreview = useMemo(() => {
    const scenarioOpt = workshopScenarioOptions.find((o) => o.id === selectedScenarioId);
    const scenarioLabel = scenarioOpt?.name ?? (selectedScenarioId || "—");
    const scenarioVersion = scenarioOpt?.versionLine;
    const scenarioLine = scenarioVersion ? `${scenarioLabel} · ${scenarioVersion}` : scenarioLabel;

    return {
      step1Rows: [
        { k: "工作模式", v: mode === "refine" ? "结果优化（refine）" : "定向生成（generate）" },
        { k: "entrypoint", v: "workshop" },
      ],
      step2Rows: [
        { k: "project_id", v: selectedProjectId || "（未选择）" },
        { k: "project_name", v: selectedProject?.name ?? "—" },
        { k: "项目状态", v: selectedProject?.status ?? "—" },
      ],
      step3Rows: [
        { k: "scenario_id", v: selectedScenarioId || "（未选择）" },
        { k: "场景 / 版本", v: scenarioLine },
        { k: "skill", v: selectedSkill ?? "（未选择）" },
        { k: "技能模板名称", v: selectedSkillMeta?.name ?? "—" },
        {
          k: "overrides.skills",
          v: selectedSkill
            ? `manual_only，白名单 [${selectedSkill}]，allow_agent_free_choice: false`
            : "需选择技能后生效",
        },
      ],
      taskInputJson: JSON.stringify({ title: derivedTaskTitle }, null, 2),
      userMessageJson: selectedSkill
        ? JSON.stringify(
            {
              skill: selectedSkill,
              mode,
              title: derivedTaskTitle,
              project_name: selectedProject?.name ?? null,
            },
            null,
            2,
          )
        : "// 选择技能后将写入 user_message：skill、mode、title、project_name",
    };
  }, [
    derivedTaskTitle,
    mode,
    selectedProject?.name,
    selectedProject?.status,
    selectedProjectId,
    selectedScenarioId,
    selectedSkill,
    selectedSkillMeta?.name,
    workshopScenarioOptions,
  ]);

  const outputPreviewSlice = useMemo(() => {
    if (errorMsg) return `❌ ${errorMsg}`;
    if (!output) {
      if (genStatus === "generating") return "执行中，等待首段输出…";
      return "尚未执行。开始生成后，上方缩略与下方正文将同步更新。";
    }
    return output.length > 8000 ? `${output.slice(0, 8000)}\n\n…（正文较长，缩略已截断）` : output;
  }, [errorMsg, genStatus, output]);

  const handleSubmit = useCallback(() => {
    if (!selectedProjectId) {
      alert("请先选择项目；结果工坊需在项目上下文中执行。");
      return;
    }
    if (!selectedScenarioId || loadingScenarios) {
      alert("请等待场景列表加载完成并选择场景");
      return;
    }
    if (!selectedSkill) {
      alert("请选择技能模板");
      return;
    }

    setOutput("");
    setErrorMsg("");
    setGenStatus("generating");
    setCopied(false);

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const taskInput: TaskInputPayload = {
      title: derivedTaskTitle,
    };

    const body: TaskExecuteBody = {
      entrypoint: "workshop",
      project_id: selectedProjectId,
      scenario_id: selectedScenarioId,
      user_message: JSON.stringify({ skill: selectedSkill, ...buildContext() }),
      task_input: taskInput,
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
  }, [buildContext, derivedTaskTitle, loadingScenarios, selectedProjectId, selectedScenarioId, selectedSkill]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Link href="/" className="text-sm text-slate-400 transition hover:text-white">
              ← 返回首页
            </Link>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            场景输出
          </div>
          <h1 className="mt-4 text-3xl font-bold sm:text-4xl">场景输出</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
            基于项目与场景编排中的场景执行生成，沉淀正式输出物。请依次：选择项目、选择场景与技能模板，确认后开始执行。
          </p>
        </div>

        <section className="mb-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
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
                  active={mode === "generate"}
                  title="定向生成"
                  desc="按要点生成新稿"
                  onClick={() => setMode("generate")}
                />
                <ModeCard
                  active={mode === "refine"}
                  title="结果优化"
                  desc="润色与重写已有内容"
                  onClick={() => setMode("refine")}
                />
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 2</p>
              <h2 className="mt-2 text-xl font-semibold">项目选择</h2>

              <div className="mt-5 space-y-4">
                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">关联项目（必选）</span>
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500"
                  >
                    <option value="">选择项目…</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-500">
                    未有项目？{" "}
                    <Link href="/projects/new" className="text-blue-400 hover:text-blue-300">
                      新建项目
                    </Link>
                    {" · "}
                    <Link href="/projects" className="text-blue-400 hover:text-blue-300">
                      项目列表
                    </Link>
                  </p>
                </label>

                {selectedProject ? (
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">项目信息</p>
                    <p className="mt-2 text-base font-semibold text-white">{selectedProject.name}</p>
                    <dl className="mt-4 space-y-3 text-sm">
                      <div>
                        <dt className="text-xs text-slate-500">状态</dt>
                        <dd className="mt-0.5 text-slate-200">{selectedProject.status || "—"}</dd>
                      </div>
                      {selectedProject.description?.trim() ? (
                        <div>
                          <dt className="text-xs text-slate-500">描述</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap text-slate-200">{selectedProject.description}</dd>
                        </div>
                      ) : null}
                      {selectedProject.background?.trim() ? (
                        <div>
                          <dt className="text-xs text-slate-500">项目背景</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap text-slate-200">{selectedProject.background}</dd>
                        </div>
                      ) : null}
                      {selectedProject.audience?.trim() ? (
                        <div>
                          <dt className="text-xs text-slate-500">目标受众</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap text-slate-200">{selectedProject.audience}</dd>
                        </div>
                      ) : null}
                      {selectedProject.deadline?.trim() ? (
                        <div>
                          <dt className="text-xs text-slate-500">截止时间</dt>
                          <dd className="mt-0.5 text-slate-200">{selectedProject.deadline}</dd>
                        </div>
                      ) : null}
                      {selectedProject.constraints && Object.keys(selectedProject.constraints).length > 0 ? (
                        <div>
                          <dt className="text-xs text-slate-500">约束 / 元数据</dt>
                          <dd className="mt-0.5">
                            <pre className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs text-slate-300">
                              {JSON.stringify(selectedProject.constraints, null, 2)}
                            </pre>
                          </dd>
                        </div>
                      ) : null}
                      {(selectedProject.updated_at || selectedProject.created_at) && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 pt-3 text-xs text-slate-500">
                          {selectedProject.created_at ? <span>创建：{selectedProject.created_at}</span> : null}
                          {selectedProject.updated_at ? <span>更新：{selectedProject.updated_at}</span> : null}
                        </div>
                      )}
                    </dl>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-8 text-center text-sm text-slate-500">
                    选择项目后，将在此展示项目档案中的描述、背景与受众等信息。
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 3</p>
                  <h2 className="mt-2 text-xl font-semibold">场景选择</h2>
                </div>
                <span className="text-xs text-slate-500">
                  {loading ? "加载中..." : `共 ${skills.length} 个技能`}
                </span>
              </div>

              <label className="mt-5 block space-y-2 text-sm">
                <span className="text-slate-300">场景（与场景编排一致）</span>
                <select
                  value={selectedScenarioId}
                  onChange={(e) => setSelectedScenarioId(e.target.value)}
                  disabled={loadingScenarios || workshopScenarioOptions.length === 0}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">
                    {loadingScenarios ? "加载场景…" : workshopScenarioOptions.length ? "选择场景…" : "无可用场景"}
                  </option>
                  {workshopScenarioOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} · {o.versionLine}
                    </option>
                  ))}
                </select>
              </label>

              {selectedScenarioContext && selectedScenarioId ? (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">场景信息</p>
                  <p className="mt-2 text-base font-semibold text-white">{selectedScenarioContext.title}</p>
                  {selectedScenarioContext.versionLine ? (
                    <p className="mt-1 text-xs text-slate-500">{selectedScenarioContext.versionLine}</p>
                  ) : null}
                  {selectedScenarioContext.remote?.code ? (
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      code · {selectedScenarioContext.remote.code}
                    </p>
                  ) : null}

                  {selectedScenarioContext.preset ? (
                    <dl className="mt-4 space-y-3 text-sm">
                      <div>
                        <dt className="text-xs text-slate-500">场景摘要</dt>
                        <dd className="mt-0.5 text-slate-200">{selectedScenarioContext.preset.summary}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">输出目标</dt>
                        <dd className="mt-0.5 text-slate-200">{selectedScenarioContext.preset.goal}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">推荐文档形态</dt>
                        <dd className="mt-0.5 text-slate-200">{selectedScenarioContext.preset.recommendedTemplate}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">知识使用策略</dt>
                        <dd className="mt-0.5 text-slate-200">
                          {selectedScenarioContext.preset.recommendedKnowledgeMode}
                        </dd>
                      </div>
                      <div>
                        <dt className="mb-1.5 text-xs text-slate-500">推荐章节结构</dt>
                        <dd className="flex flex-wrap gap-1.5">
                          {selectedScenarioContext.preset.recommendedSections.map((sec) => (
                            <span
                              key={sec}
                              className="rounded-md border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-xs text-slate-300"
                            >
                              {sec}
                            </span>
                          ))}
                        </dd>
                      </div>
                      <details className="group border-t border-slate-800 pt-3">
                        <summary className="cursor-pointer text-xs text-slate-400 transition hover:text-slate-200">
                          系统角色与输出风格（编排上下文）
                        </summary>
                        <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed text-slate-400">
                          {selectedScenarioContext.preset.systemContext}
                        </pre>
                      </details>
                    </dl>
                  ) : selectedScenarioContext.remote?.description?.trim() ? (
                    <div className="mt-4">
                      <p className="text-xs text-slate-500">服务端描述</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
                        {selectedScenarioContext.remote.description}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-4 text-xs text-slate-500">
                      该场景为服务端扩展配置；详细编排可在「场景编排」中查看与维护。
                    </p>
                  )}
                </div>
              ) : !loadingScenarios && workshopScenarioOptions.length > 0 ? (
                <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-6 text-center text-sm text-slate-500">
                  选择场景后，将展示与编排一致的摘要、目标与推荐结构等信息。
                </div>
              ) : null}

              <div className="mt-6 border-t border-slate-800 pt-5">
                <div className="mb-1 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">技能模板</p>
                    <p className="mt-1 text-sm text-slate-400">Skill · 与任务执行时允许的技能白名单一致</p>
                  </div>
                </div>

                {loading && (
                  <p className="py-8 text-center text-sm text-slate-400">正在加载技能与项目...</p>
                )}

                {!loading && skills.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-500">
                    暂无可用技能；请确认后端 `/skills/` 或设置 `NEXT_PUBLIC_USE_MOCK_WORKSHOP=true`。
                  </p>
                )}

                {!loading &&
                  skills.length > 0 &&
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

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 4</p>
              <h2 className="mt-2 text-xl font-semibold">任务信息</h2>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Hermes 编排下发汇总</p>
                    <p className="mt-1 text-sm text-slate-400">
                      Step 1–3 对应信息；与点击「开始生成」时 POST <span className="font-mono text-slate-300">/tasks/execute</span>{" "}
                      中的 <span className="font-mono text-slate-300">project_id</span>、
                      <span className="font-mono text-slate-300">scenario_id</span>、
                      <span className="font-mono text-slate-300">task_input</span>、
                      <span className="font-mono text-slate-300">user_message</span>、
                      <span className="font-mono text-slate-300">overrides</span> 一致
                    </p>
                  </div>

                  <div className="mt-4 space-y-4 border-t border-slate-800/80 pt-4">
                    {(
                      [
                        { title: "Step 1", subtitle: "结果处理模式", rows: agentExecutePreview.step1Rows },
                        { title: "Step 2", subtitle: "项目上下文", rows: agentExecutePreview.step2Rows },
                        { title: "Step 3", subtitle: "场景与技能", rows: agentExecutePreview.step3Rows },
                      ] as const
                    ).map((block) => (
                      <div key={block.title}>
                        <p className="text-xs font-medium text-slate-300">
                          {block.title} · {block.subtitle}
                        </p>
                        <dl className="mt-2 space-y-1.5 text-xs">
                          {block.rows.map((row) => (
                            <div
                              key={row.k}
                              className="grid gap-1 rounded-lg bg-slate-900/40 px-2 py-1.5 sm:grid-cols-[minmax(0,10rem)_1fr]"
                            >
                              <dt className="text-slate-500">{row.k}</dt>
                              <dd className="break-words font-mono text-[11px] leading-relaxed text-slate-200 sm:text-xs">
                                {row.v}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 border-t border-slate-800/80 pt-4">
                    <p className="text-xs font-medium text-slate-400">task_input（JSON）</p>
                    <pre className="mt-1 max-h-28 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                      {agentExecutePreview.taskInputJson}
                    </pre>
                    <p className="mt-3 text-xs font-medium text-slate-400">user_message（JSON 内容）</p>
                    <pre className="mt-1 max-h-36 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                      {agentExecutePreview.userMessageJson}
                    </pre>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">已沉淀输出</p>
                      <p className="mt-1 text-sm text-slate-400">
                        当前项目下，与 Step 3 所选场景关联的 outputs 历史记录
                      </p>
                    </div>
                    {selectedProjectId ? (
                      <Link
                        href={`/projects/${selectedProjectId}`}
                        className="shrink-0 text-xs text-blue-400 transition hover:text-blue-300"
                      >
                        项目详情 · 输出沉淀 →
                      </Link>
                    ) : null}
                  </div>
                  {!selectedProjectId || !selectedScenarioId ? (
                    <p className="mt-3 text-sm text-slate-500">请先完成项目与场景选择。</p>
                  ) : scenarioOutputsLoading ? (
                    <p className="mt-3 text-sm text-slate-400">加载产出列表…</p>
                  ) : scenarioLinkedOutputs.length === 0 ? (
                    <p className="mt-3 text-sm text-slate-500">
                      该场景下尚无已沉淀输出；编排执行成功并写入 outputs 后将显示在此。
                    </p>
                  ) : (
                    <ul className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                      {scenarioLinkedOutputs.map((o) => {
                        const preview = (o.summary || o.content_preview || "").replace(/\s+/g, " ").trim();
                        const previewShort =
                          preview.length > 140 ? `${preview.slice(0, 140)}…` : preview || "（无摘要）";
                        return (
                          <li
                            key={o.id}
                            className="rounded-xl border border-slate-800/90 bg-slate-900/50 px-3 py-2.5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium text-white">
                                {o.title?.trim() || "未命名输出"}
                              </span>
                              <span className="text-xs text-slate-500">{formatOutputTime(o.created_at)}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-400">
                                {o.status}
                              </span>
                              {o.template_id ? (
                                <span className="text-slate-500">模板 {o.template_id}</span>
                              ) : null}
                            </div>
                            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{previewShort}</p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={genStatus === "generating"}
                className={`mt-5 w-full rounded-2xl px-5 py-3 text-sm font-medium transition ${
                  genStatus === "generating"
                    ? "cursor-not-allowed bg-slate-700 text-slate-500"
                    : "bg-blue-600 text-white hover:bg-blue-500"
                }`}
              >
                {genStatus === "generating" ? "执行中…" : mode === "refine" ? "开始优化" : "开始生成"}
              </button>
            </div>

          </div>

          <aside className="min-h-0 space-y-6 xl:sticky xl:top-6 xl:self-start">
            <section className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold">执行结果</h2>
                <div className="flex flex-wrap items-center gap-2 sm:gap-3">
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

              <div className="mb-3 rounded-2xl border border-slate-700/90 bg-slate-900/70 p-3">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">产出物缩略</p>
                <p className="mt-0.5 text-[11px] text-slate-500">与下方「内容详情」同一正文，缩放展示便于扫版</p>
                <div className="relative mt-2 flex h-44 items-start justify-center overflow-hidden rounded-xl border border-slate-600/80 bg-gradient-to-b from-slate-900 to-slate-950 shadow-inner">
                  <div
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-12 bg-gradient-to-t from-slate-950 via-slate-950/90 to-transparent"
                    aria-hidden
                  />
                  <div
                    className="origin-top border border-slate-600/60 bg-slate-900/95 shadow-md"
                    style={{
                      transform: "scale(0.26)",
                      width: "min(42rem, 92vw)",
                    }}
                  >
                    <pre className="max-h-[32rem] whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-slate-200">
                      {outputPreviewSlice}
                    </pre>
                  </div>
                </div>
              </div>

              <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-slate-500">内容详情</p>
              <div className="min-h-48 max-h-[min(32rem,calc(100vh-12rem))] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950/60 p-5 xl:min-h-72">
                {genStatus === "idle" && !output && (
                  <p className="text-sm text-slate-500">点击「开始」后在此查看输出</p>
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
          </aside>
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
