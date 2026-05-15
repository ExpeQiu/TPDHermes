"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiV1, apiFetch, readJson } from "@/lib/api";
import type { ProjectRecord, TaskExecuteBody, TaskInputPayload } from "@/lib/chat-context";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

type GenStatus = "idle" | "generating" | "done" | "error";
type WorkshopMode = "refine" | "generate";

type BoundScenarioRow = {
  binding_id: string;
  scenario_id: string;
  scenario_code: string;
  scenario_name: string;
  scenario_version: string;
  scenario_description: string | null;
  scenario_status: string;
  is_default: number;
  enabled: number;
};

type ScenarioDetailResponse = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  knowledge_policy: Record<string, unknown>;
  skills_policy: Record<string, unknown>;
  output_policy: Record<string, unknown>;
  version: string;
  status: string;
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

type ProjectOutputDetailApi = {
  id: string;
  content: string;
  scenario_id?: string | null;
};

type WorkshopScenarioOption = {
  id: string;
  name: string;
  versionLine: string;
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
  const outputFromUrl = searchParams?.get("output_id")?.trim() ?? "";
  const modeFromUrl = searchParams?.get("mode") ?? "";

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [boundScenarios, setBoundScenarios] = useState<BoundScenarioRow[]>([]);
  const [loadingBound, setLoadingBound] = useState(false);
  const [scenarioDetail, setScenarioDetail] = useState<ScenarioDetailResponse | null>(null);
  const [loadingScenarioDetail, setLoadingScenarioDetail] = useState(false);

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

  const [loadingProjects, setLoadingProjects] = useState(true);
  const [mode, setMode] = useState<WorkshopMode>("generate");
  const [genStatus, setGenStatus] = useState<GenStatus>("idle");
  const [output, setOutput] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [scenarioLinkedOutputs, setScenarioLinkedOutputs] = useState<ScenarioLinkedOutputRow[]>(
    [],
  );
  const [scenarioOutputsLoading, setScenarioOutputsLoading] = useState(false);
  const [sourceOutputId, setSourceOutputId] = useState<string | null>(null);
  const [sourceMaterialPreview, setSourceMaterialPreview] = useState<string | null>(null);
  const [sourceOutputLoading, setSourceOutputLoading] = useState(false);
  const [lastRunMeta, setLastRunMeta] = useState<{
    run_id?: string;
    output_id?: string | null;
  } | null>(null);
  const [versionSaveStatus, setVersionSaveStatus] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [versionSaveMsg, setVersionSaveMsg] = useState("");
  const [outputsRefreshTick, setOutputsRefreshTick] = useState(0);
  const [taskTitleCustom, setTaskTitleCustom] = useState("");
  const [taskBackground, setTaskBackground] = useState("");
  const [taskObjective, setTaskObjective] = useState("");
  const [taskKeywords, setTaskKeywords] = useState("");
  const [taskExtra, setTaskExtra] = useState("");
  const [taskTone, setTaskTone] = useState("");

  useEffect(() => {
    if (projectFromUrl) setSelectedProjectId(projectFromUrl);
  }, [projectFromUrl]);

  useEffect(() => {
    setLoadingProjects(true);
    apiGet<ProjectRecord[]>("/projects/")
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setBoundScenarios([]);
      setLoadingBound(false);
      return;
    }
    let cancelled = false;
    setLoadingBound(true);
    apiGet<BoundScenarioRow[]>(`/projects/${selectedProjectId}/scenarios`)
      .then((rows) => {
        if (!cancelled) setBoundScenarios(rows.filter((r) => r.enabled === 1));
      })
      .catch((err) => {
        if (process.env.NODE_ENV === "development") {
          console.warn("[workshop] 项目绑定场景加载失败", err);
        }
        if (!cancelled) setBoundScenarios([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBound(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (!outputFromUrl || !selectedProjectId) {
      setSourceOutputId(null);
      setSourceMaterialPreview(null);
      setSourceOutputLoading(false);
      return;
    }
    let cancelled = false;
    setSourceOutputLoading(true);
    apiGet<ProjectOutputDetailApi>(`/projects/${selectedProjectId}/outputs/${outputFromUrl}`)
      .then((d) => {
        if (cancelled) return;
        setSourceOutputId(outputFromUrl);
        setSourceMaterialPreview(d.content || "");
        if (modeFromUrl === "refine") setMode("refine");
        if (d.scenario_id) {
          setSelectedScenarioId((prev) =>
            prev === d.scenario_id ? prev : d.scenario_id || prev,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceOutputId(null);
          setSourceMaterialPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setSourceOutputLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [outputFromUrl, selectedProjectId, modeFromUrl]);

  const workshopScenarioOptions = useMemo((): WorkshopScenarioOption[] => {
    return boundScenarios
      .filter((r) => {
        if (r.enabled !== 1) return false;
        const st = (r.scenario_status || "draft").toLowerCase();
        return st === "published";
      })
      .map((r) => ({
        id: r.scenario_id,
        name: r.scenario_name,
        versionLine: `${r.scenario_status} · v${r.scenario_version}${r.is_default ? " · 默认" : ""}`,
      }));
  }, [boundScenarios]);

  useEffect(() => {
    if (workshopScenarioOptions.length === 0) {
      setSelectedScenarioId("");
      return;
    }
    if (scenarioFromUrl && workshopScenarioOptions.some((o) => o.id === scenarioFromUrl)) {
      setSelectedScenarioId(scenarioFromUrl);
      return;
    }
    if (selectedScenarioId && workshopScenarioOptions.some((o) => o.id === selectedScenarioId)) {
      return;
    }
    const def = boundScenarios.find((b) => b.enabled === 1 && b.is_default === 1);
    if (def && workshopScenarioOptions.some((o) => o.id === def.scenario_id)) {
      setSelectedScenarioId(def.scenario_id);
      return;
    }
    setSelectedScenarioId(workshopScenarioOptions[0]?.id ?? "");
  }, [workshopScenarioOptions, scenarioFromUrl, selectedScenarioId, boundScenarios]);

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
  }, [selectedProjectId, selectedScenarioId, outputsRefreshTick]);

  useEffect(() => {
    if (!selectedScenarioId) {
      setScenarioDetail(null);
      setLoadingScenarioDetail(false);
      return;
    }
    let cancelled = false;
    setLoadingScenarioDetail(true);
    apiGet<ScenarioDetailResponse>(`/scenarios/${selectedScenarioId}`)
      .then((d) => {
        if (!cancelled) setScenarioDetail(d);
      })
      .catch(() => {
        if (!cancelled) setScenarioDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingScenarioDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScenarioId]);

  const allowedSkills = useMemo(() => {
    const pol = scenarioDetail?.skills_policy;
    if (!pol || typeof pol !== "object") return [] as string[];
    const raw = (pol as { allowed?: unknown }).allowed;
    return Array.isArray(raw) ? raw.map((x) => String(x)).filter(Boolean) : [];
  }, [scenarioDetail]);

  useEffect(() => {
    if (allowedSkills.length === 0) {
      setSelectedSkill(null);
      return;
    }
    if (allowedSkills.length === 1) {
      setSelectedSkill(allowedSkills[0]);
      return;
    }
    setSelectedSkill((prev) =>
      prev && allowedSkills.includes(prev) ? prev : allowedSkills[0] ?? null,
    );
  }, [allowedSkills]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const derivedTaskTitle = useMemo(() => {
    const projectName = selectedProject?.name?.trim() || "项目";
    const scenarioName =
      workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "场景";
    const skillPart = selectedSkill ?? allowedSkills[0] ?? "技能";
    return `${projectName} · ${scenarioName} · ${skillPart}`;
  }, [
    selectedProject?.name,
    workshopScenarioOptions,
    selectedScenarioId,
    selectedSkill,
    allowedSkills,
  ]);

  useEffect(() => {
    if (outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [output]);

  const buildContext = useCallback(
    () => ({
      mode,
      title: taskTitleCustom.trim() || derivedTaskTitle,
      project_name: selectedProject?.name ?? null,
    }),
    [derivedTaskTitle, mode, selectedProject?.name, taskTitleCustom],
  );

  const contractSummaryText = useMemo(() => {
    if (!scenarioDetail) return "";
    try {
      return JSON.stringify(
        {
          knowledge_policy: scenarioDetail.knowledge_policy,
          skills_policy: scenarioDetail.skills_policy,
          output_policy: scenarioDetail.output_policy,
        },
        null,
        2,
      );
    } catch {
      return "";
    }
  }, [scenarioDetail]);

  const summaryItems = useMemo(
    () => [
      { label: "工作模式", value: mode === "refine" ? "结果优化" : "定向生成" },
      { label: "关联项目", value: selectedProject?.name ?? "请先选择项目" },
      {
        label: "场景",
        value:
          workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "—",
      },
      {
        label: "技能（合同）",
        value:
          allowedSkills.length === 0
            ? "场景未配置 allowed"
            : allowedSkills.length === 1
              ? allowedSkills[0]
              : selectedSkill ?? allowedSkills[0] ?? "请选择",
      },
    ],
    [mode, selectedProject?.name, workshopScenarioOptions, selectedScenarioId, allowedSkills, selectedSkill],
  );

  const agentExecutePreview = useMemo(() => {
    const scenarioOpt = workshopScenarioOptions.find((o) => o.id === selectedScenarioId);
    const scenarioLabel = scenarioOpt?.name ?? (selectedScenarioId || "—");
    const scenarioVersion = scenarioOpt?.versionLine;
    const scenarioLine = scenarioVersion ? `${scenarioLabel} · ${scenarioVersion}` : scenarioLabel;
    const skillRun = selectedSkill ?? allowedSkills[0] ?? "";
    const contractSlice = contractSummaryText
      ? contractSummaryText.slice(0, 1200) + (contractSummaryText.length > 1200 ? "…" : "")
      : "（加载中或未选场景）";
    const effTitle = taskTitleCustom.trim() || derivedTaskTitle;
    const kwParts = taskKeywords
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const taskPayload: TaskInputPayload = {
      title: effTitle,
      ...(taskBackground.trim() ? { background: taskBackground.trim() } : {}),
      ...(taskObjective.trim() ? { objective: taskObjective.trim() } : {}),
      ...(kwParts.length ? { keywords: kwParts } : {}),
      ...(taskExtra.trim() ? { extra: taskExtra.trim() } : {}),
      ...(taskTone.trim() ? { tone: taskTone.trim() } : {}),
    };

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
        { k: "skill（执行）", v: skillRun || "（合同未配置或待选）" },
        { k: "场景合同摘要", v: contractSlice },
        {
          k: "overrides.skills",
          v: skillRun
            ? `manual_only，白名单 [${skillRun}]，allow_agent_free_choice: false`
            : "需场景 skills_policy.allowed",
        },
      ],
      taskInputJson: JSON.stringify(taskPayload, null, 2),
      userMessageJson: skillRun
        ? JSON.stringify(
            {
              skill: skillRun,
              mode,
              title: effTitle,
              project_name: selectedProject?.name ?? null,
            },
            null,
            2,
          )
        : "// 等待场景合同与技能白名单",
    };
  }, [
    derivedTaskTitle,
    mode,
    selectedProject?.name,
    selectedProject?.status,
    selectedProjectId,
    selectedScenarioId,
    selectedSkill,
    taskBackground,
    taskExtra,
    taskKeywords,
    taskObjective,
    taskTitleCustom,
    taskTone,
    allowedSkills,
    workshopScenarioOptions,
    contractSummaryText,
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
      alert("请先选择项目；场景输出需在项目上下文中执行。");
      return;
    }
    if (!selectedScenarioId || loadingBound) {
      alert("请等待项目绑定场景加载完成并选择场景");
      return;
    }
    if (loadingScenarioDetail || !scenarioDetail) {
      alert("场景合同加载中，请稍候");
      return;
    }
    if (allowedSkills.length === 0) {
      alert(
        "当前场景未配置 skills_policy.allowed。请在「场景编排」中维护合同，或在项目页绑定其他场景。",
      );
      return;
    }
    const skillForRun =
      allowedSkills.length === 1 ? allowedSkills[0] : selectedSkill ?? allowedSkills[0];
    if (!skillForRun) {
      alert("请选择本场景允许范围内的一项技能");
      return;
    }

    setOutput("");
    setErrorMsg("");
    setGenStatus("generating");
    setCopied(false);
    setLastRunMeta(null);
    setVersionSaveStatus("idle");
    setVersionSaveMsg("");

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const effTitle = taskTitleCustom.trim() || derivedTaskTitle;
    const kwParts = taskKeywords
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const taskInput: TaskInputPayload = {
      title: effTitle,
      ...(taskBackground.trim() ? { background: taskBackground.trim() } : {}),
      ...(taskObjective.trim() ? { objective: taskObjective.trim() } : {}),
      ...(kwParts.length ? { keywords: kwParts } : {}),
      ...(taskExtra.trim() ? { extra: taskExtra.trim() } : {}),
      ...(taskTone.trim() ? { tone: taskTone.trim() } : {}),
      ...(mode === "refine" && sourceMaterialPreview?.trim()
        ? { source_material: sourceMaterialPreview }
        : {}),
    };

    const body: TaskExecuteBody = {
      entrypoint: "workshop",
      project_id: selectedProjectId,
      scenario_id: selectedScenarioId,
      user_message: JSON.stringify({ skill: skillForRun, ...buildContext() }),
      task_input: taskInput,
      stream: true,
      source_output_id: mode === "refine" && sourceOutputId ? sourceOutputId : null,
      overrides: {
        skills: {
          mode: "manual_only",
          allowed: [skillForRun],
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
                  const tt = event.tphermes_task;
                  if (tt && typeof tt === "object") {
                    const m = tt as Record<string, unknown>;
                    setLastRunMeta({
                      run_id: typeof m.run_id === "string" ? m.run_id : undefined,
                      output_id:
                        typeof m.output_id === "string"
                          ? m.output_id
                          : m.output_id === null
                            ? null
                            : undefined,
                    });
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
  }, [
    allowedSkills,
    buildContext,
    derivedTaskTitle,
    loadingBound,
    loadingScenarioDetail,
    scenarioDetail,
    selectedProjectId,
    selectedScenarioId,
    selectedSkill,
    mode,
    sourceMaterialPreview,
    sourceOutputId,
    taskBackground,
    taskExtra,
    taskKeywords,
    taskObjective,
    taskTitleCustom,
    taskTone,
  ]);

  const handleSaveAsNewVersion = useCallback(async () => {
    if (!selectedProjectId || !sourceOutputId || !output.trim()) {
      alert("需在「结果优化」链路下、且已产生正文后再保存版本。");
      return;
    }
    setVersionSaveStatus("saving");
    setVersionSaveMsg("");
    try {
      const res = await apiFetch(
        `/projects/${selectedProjectId}/outputs/${sourceOutputId}/versions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: output,
            scenario_id: selectedScenarioId || undefined,
          }),
        },
      );
      await readJson<{ id: string; version?: string }>(res);
      setVersionSaveStatus("ok");
      setVersionSaveMsg("已写入源输出的一条新版本，可在项目详情查看。");
      setOutputsRefreshTick((t) => t + 1);
      if (process.env.NODE_ENV === "development") {
        console.info("[workshop] output version created base_output_id=%s", sourceOutputId);
      }
    } catch (e: unknown) {
      setVersionSaveStatus("err");
      setVersionSaveMsg(e instanceof Error ? e.message : "保存失败");
    }
  }, [output, selectedProjectId, selectedScenarioId, sourceOutputId]);

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
            先选择项目，仅能使用该项目已绑定的场景；场景合同（知识 / 技能 / 输出策略）来自服务端。未绑定场景时请到项目页绑定或前往场景编排维护。
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
                  {!selectedProjectId
                    ? "先选项目"
                    : loadingScenarioDetail
                      ? "加载场景中…"
                      : "合同来自 GET /scenarios/{id}"}
                </span>
              </div>

              {!selectedProjectId ? (
                <p className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-6 text-center text-sm text-slate-500">
                  请先选择项目后，将仅展示该项目已绑定的可执行场景。
                </p>
              ) : null}

              <label className="mt-5 block space-y-2 text-sm">
                <span className="text-slate-300">场景（项目已绑定）</span>
                <select
                  value={selectedScenarioId}
                  onChange={(e) => setSelectedScenarioId(e.target.value)}
                  disabled={
                    loadingBound || !selectedProjectId || workshopScenarioOptions.length === 0
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">
                    {loadingBound
                      ? "加载绑定场景…"
                      : workshopScenarioOptions.length
                        ? "选择场景…"
                        : "该项目未绑定已启用场景"}
                  </option>
                  {workshopScenarioOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} · {o.versionLine}
                    </option>
                  ))}
                </select>
                {selectedProjectId && !loadingBound && workshopScenarioOptions.length === 0 ? (
                  <p className="mt-2 text-xs text-amber-400/90">
                    {boundScenarios.some((b) => b.enabled === 1)
                      ? "已有绑定，但场景状态均非 published（已发布），工坊无法选用。请在场景编排发布场景，或解除无效绑定。"
                      : "当前项目暂无可用绑定场景。前往 "}
                    {!boundScenarios.some((b) => b.enabled === 1) ? (
                      <>
                        <Link href={`/projects/${selectedProjectId}`} className="underline">
                          项目详情
                        </Link>{" "}
                        绑定，或打开{" "}
                        <Link href="/create" className="underline">
                          场景编排
                        </Link>{" "}
                        维护场景。
                      </>
                    ) : null}
                  </p>
                ) : null}
              </label>

              {selectedScenarioId && scenarioDetail ? (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">场景合同（服务端）</p>
                  <p className="mt-2 text-base font-semibold text-white">{scenarioDetail.name}</p>
                  <p className="mt-1 font-mono text-xs text-slate-500">code · {scenarioDetail.code}</p>
                  {scenarioDetail.description?.trim() ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">
                      {scenarioDetail.description}
                    </p>
                  ) : null}
                  <details className="mt-4 group border-t border-slate-800 pt-3">
                    <summary className="cursor-pointer text-xs text-slate-400 transition hover:text-slate-200">
                      knowledge_policy / skills_policy / output_policy
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/80 p-3 font-mono text-xs leading-relaxed text-slate-400">
                      {contractSummaryText || "—"}
                    </pre>
                  </details>
                </div>
              ) : selectedScenarioId && loadingScenarioDetail ? (
                <p className="mt-4 text-sm text-slate-500">加载场景合同…</p>
              ) : !loadingBound && workshopScenarioOptions.length > 0 && !selectedScenarioId ? (
                <div className="mt-4 rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-6 text-center text-sm text-slate-500">
                  请选择场景以加载服务端合同与技能白名单。
                </div>
              ) : null}

              <div className="mt-6 border-t border-slate-800 pt-5">
                <div className="mb-1 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">场景允许的技能</p>
                    <p className="mt-1 text-sm text-slate-400">
                      源自场景合同的 <span className="font-mono text-slate-300">skills_policy.allowed</span>
                      ，不可从全局技能库任选
                    </p>
                  </div>
                </div>

                {loadingScenarioDetail || (selectedScenarioId && !scenarioDetail) ? (
                  <p className="py-6 text-center text-sm text-slate-400">加载合同以解析技能范围…</p>
                ) : allowedSkills.length === 0 ? (
                  <p className="py-6 text-center text-sm text-amber-400/90">
                    当前场景未配置允许技能列表，请在场景编排中编辑 skills_policy.allowed。
                  </p>
                ) : allowedSkills.length === 1 ? (
                  <p className="rounded-2xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-200">
                    本场景固定技能：<span className="font-mono text-blue-200">{allowedSkills[0]}</span>
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {allowedSkills.map((pkg) => {
                      const active = selectedSkill === pkg;
                      return (
                        <button
                          key={pkg}
                          type="button"
                          onClick={() => setSelectedSkill(pkg)}
                          className={`rounded-2xl border p-4 text-left text-sm transition ${
                            active
                              ? "border-blue-500 bg-blue-500/10"
                              : "border-slate-700 bg-slate-950/60 hover:border-slate-600"
                          }`}
                        >
                          <span className="font-mono text-white">{pkg}</span>
                          {active ? (
                            <span className="mt-2 block text-xs text-blue-300">将用于本次执行</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 4</p>
              <h2 className="mt-2 text-xl font-semibold">任务信息</h2>
              <p className="mt-1 text-sm text-slate-500">
                以下为本次任务输入（task_input），将并入编排与技能上下文；标题留空则使用自动摘要。
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5 text-sm sm:col-span-2">
                  <span className="text-slate-400">任务标题</span>
                  <input
                    type="text"
                    value={taskTitleCustom}
                    onChange={(e) => setTaskTitleCustom(e.target.value)}
                    placeholder={derivedTaskTitle}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm sm:col-span-2">
                  <span className="text-slate-400">背景补充</span>
                  <textarea
                    value={taskBackground}
                    onChange={(e) => setTaskBackground(e.target.value)}
                    rows={2}
                    placeholder="业务背景、已知事实、引用材料说明等"
                    className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm sm:col-span-2">
                  <span className="text-slate-400">任务目标</span>
                  <textarea
                    value={taskObjective}
                    onChange={(e) => setTaskObjective(e.target.value)}
                    rows={2}
                    placeholder="本轮要达成的结果、交付形态、读者等"
                    className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="text-slate-400">关键词</span>
                  <input
                    type="text"
                    value={taskKeywords}
                    onChange={(e) => setTaskKeywords(e.target.value)}
                    placeholder="用逗号或中文逗号分隔"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="text-slate-400">语气 / 风格</span>
                  <input
                    type="text"
                    value={taskTone}
                    onChange={(e) => setTaskTone(e.target.value)}
                    placeholder="如：正式、简洁、口语化"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm sm:col-span-2">
                  <span className="text-slate-400">附加要求（extra）</span>
                  <textarea
                    value={taskExtra}
                    onChange={(e) => setTaskExtra(e.target.value)}
                    rows={2}
                    placeholder="篇幅、禁忌、格式等一次性约束"
                    className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
              </div>

              {sourceOutputLoading ? (
                <p className="mt-2 text-sm text-slate-500">加载来源输出全文…</p>
              ) : null}
              {mode === "refine" && sourceOutputId && sourceMaterialPreview ? (
                <p className="mt-2 rounded-2xl border border-amber-700/35 bg-amber-950/25 px-3 py-2 text-xs text-amber-200/90">
                  优化来源：<span className="font-mono">{sourceOutputId}</span>
                  ，已映射至本轮 <span className="font-mono">source_output_id</span> /
                  <span className="font-mono">source_material</span>
                </p>
              ) : null}

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

              {genStatus === "done" && lastRunMeta?.output_id ? (
                <p className="mb-3 text-xs text-slate-400">
                  本轮编排已写入项目输出{" "}
                  <span className="font-mono text-slate-300">{lastRunMeta.output_id}</span>
                  {selectedProjectId ? (
                    <>
                      {" "}
                      ·{" "}
                      <Link
                        href={`/projects/${selectedProjectId}`}
                        className="text-blue-400 hover:text-blue-300"
                      >
                        打开项目详情
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}

              {mode === "refine" && sourceOutputId && genStatus === "done" && output.trim() ? (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSaveAsNewVersion()}
                    disabled={versionSaveStatus === "saving"}
                    className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    {versionSaveStatus === "saving" ? "保存中…" : "保存为源输出的新版本"}
                  </button>
                  {versionSaveMsg ? (
                    <span
                      className={`text-xs ${versionSaveStatus === "err" ? "text-red-400" : "text-slate-400"}`}
                    >
                      {versionSaveMsg}
                    </span>
                  ) : null}
                </div>
              ) : null}

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
