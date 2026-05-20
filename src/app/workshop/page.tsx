"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiFetch, readJson } from "@/lib/api";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import type { ProjectRecord, TaskExecuteBody, TaskInputPayload } from "@/lib/chat-context";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import {
  loadProjectQuickScenarios,
  quickScenariosScopeId,
  resolveWorkshopScenarioId,
} from "@/lib/project-quick-scenarios";
import {
  buildScenarioListItems,
  countLocalTemplates,
  isScenarioPublished,
  loadDismissedPresetIds,
  type ScenarioApiRow,
  type ScenarioListItem,
} from "@/lib/scenario-list";
import {
  parseScenarioSkills,
  skillsPolicyModeLabel,
  type ParsedScenarioSkills,
  type ScenarioSkillBinding,
} from "@/lib/scenario-skills";
import {
  deriveWorkshopArtifacts,
  formatFromOutputPolicy,
  normalizeWorkshopOutputFormat,
  type WorkshopOutputFormat,
} from "@/lib/workshop-output-artifact";
import { WorkshopOutputPanel } from "@/components/workshop-output-panel";
import {
  POLICY_SECTION_SUMMARY,
  TASK_EXECUTE_HINT,
  entrypointLabel,
  fieldLabel,
  outputStatusLabel,
  projectStatusLabel,
  scenarioStatusLabel,
  stepLabel,
  stepRangeLabel,
  taskInputSectionTitle,
  userMessageSectionTitle,
  skillsOverrideSummary,
  workshopModeLabel,
} from "@/lib/ui-labels";

type SkillTemplateMeta = {
  id: string;
  label: string;
  path: string;
  tags?: string[];
  sections?: string[];
};

type SkillMetaRow = {
  name: string;
  display_name: string;
  description: string;
  templates: SkillTemplateMeta[];
};

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
  const scopeUserId = useEffectiveUserScopeId();
  const searchParams = useSearchParams();
  const projectFromUrl =
    searchParams?.get("project_id") ?? searchParams?.get("project") ?? "";
  const scenarioFromUrl = searchParams?.get("scenario_id") ?? "";
  const outputFromUrl = searchParams?.get("output_id")?.trim() ?? "";
  const modeFromUrl = searchParams?.get("mode") ?? "";

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [remoteScenarios, setRemoteScenarios] = useState<ScenarioApiRow[]>([]);
  const [dismissedPresetIds] = useState(loadDismissedPresetIds);
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
  const [savedOutputFormat, setSavedOutputFormat] = useState<WorkshopOutputFormat | null>(null);
  const [versionSaveStatus, setVersionSaveStatus] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [versionSaveMsg, setVersionSaveMsg] = useState("");
  const [outputsRefreshTick, setOutputsRefreshTick] = useState(0);
  const [taskTitleCustom, setTaskTitleCustom] = useState("");
  const [taskBackground, setTaskBackground] = useState("");
  const [taskObjective, setTaskObjective] = useState("");
  const [taskKeywords, setTaskKeywords] = useState("");
  const [taskExtra, setTaskExtra] = useState("");
  const [taskTone, setTaskTone] = useState("");
  const [skillMeta, setSkillMeta] = useState<SkillMetaRow[]>([]);

  useEffect(() => {
    if (projectFromUrl) setSelectedProjectId(projectFromUrl);
  }, [projectFromUrl]);

  useEffect(() => {
    apiGet<{ skills: SkillMetaRow[] }>("/ws/skills/metadata")
      .then((r) => setSkillMeta(r.skills ?? []))
      .catch(() => setSkillMeta([]));
  }, []);

  useEffect(() => {
    setLoadingProjects(true);
    apiGet<ProjectRecord[]>("/projects/")
      .then(setProjects)
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false));
  }, []);

  useEffect(() => {
    apiGet<ScenarioApiRow[]>("/scenarios/")
      .then(setRemoteScenarios)
      .catch(() => setRemoteScenarios([]));
  }, []);

  const scenarioListItems = useMemo(
    () => buildScenarioListItems(remoteScenarios, dismissedPresetIds),
    [remoteScenarios, dismissedPresetIds],
  );

  const localTemplateCount = useMemo(
    () => countLocalTemplates(remoteScenarios, dismissedPresetIds),
    [remoteScenarios, dismissedPresetIds],
  );

  const boundByScenarioId = useMemo(
    () => new Map(boundScenarios.map((b) => [b.scenario_id, b] as const)),
    [boundScenarios],
  );

  const isWorkshopSelectable = useCallback((item: ScenarioListItem): boolean => {
    if (item.isLocalTemplate) return false;
    return isScenarioPublished(item.remote);
  }, []);

  const isWorkshopExecutable = useCallback(
    (item: ScenarioListItem): boolean => {
      if (!isWorkshopSelectable(item)) return false;
      const binding = boundByScenarioId.get(item.id);
      return Boolean(binding && binding.enabled === 1);
    },
    [boundByScenarioId, isWorkshopSelectable],
  );

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

  const projectQuickScenarios = useMemo(() => {
    if (!selectedProjectId) return null;
    return loadProjectQuickScenarios(quickScenariosScopeId(), selectedProjectId);
  }, [selectedProjectId]);

  const quickScenarioIdSet = useMemo(
    () => new Set(projectQuickScenarios?.scenarioIds ?? []),
    [projectQuickScenarios],
  );

  const workshopDisplayScenarios = useMemo(() => {
    const published = scenarioListItems.filter((item) => isWorkshopSelectable(item));
    return published.sort((a, b) => {
      const aQuick = quickScenarioIdSet.has(a.id) ? 0 : 1;
      const bQuick = quickScenarioIdSet.has(b.id) ? 0 : 1;
      if (aQuick !== bQuick) return aQuick - bQuick;
      const aBound = boundByScenarioId.has(a.id) ? 0 : 1;
      const bBound = boundByScenarioId.has(b.id) ? 0 : 1;
      if (aBound !== bBound) return aBound - bBound;
      return a.title.localeCompare(b.title, "zh-CN");
    });
  }, [scenarioListItems, isWorkshopSelectable, quickScenarioIdSet, boundByScenarioId]);

  const workshopScenarioOptions = useMemo((): WorkshopScenarioOption[] => {
    return scenarioListItems
      .filter((item) => isWorkshopExecutable(item))
      .map((item) => {
        const binding = boundByScenarioId.get(item.id)!;
        const isQuickDefault =
          projectQuickScenarios?.defaultScenarioId === item.id ||
          quickScenarioIdSet.has(item.id) ||
          (binding.is_default === 1 && !projectQuickScenarios?.scenarioIds?.length);
        return {
          id: item.id,
          name: item.title,
          versionLine: `${scenarioStatusLabel(binding.scenario_status)} · v${binding.scenario_version}${
            isQuickDefault ? " · 默认" : ""
          }`,
        };
      });
  }, [
    scenarioListItems,
    boundByScenarioId,
    isWorkshopExecutable,
    projectQuickScenarios,
    quickScenarioIdSet,
  ]);

  useEffect(() => {
    if (!selectedProjectId || loadingBound) return;
    if (workshopDisplayScenarios.length === 0) {
      setSelectedScenarioId("");
      return;
    }
    const inDisplay = (id: string) => workshopDisplayScenarios.some((s) => s.id === id);

    if (scenarioFromUrl && inDisplay(scenarioFromUrl)) {
      setSelectedScenarioId(scenarioFromUrl);
      return;
    }
    if (selectedScenarioId && inDisplay(selectedScenarioId)) {
      return;
    }
    const quickDefault = resolveWorkshopScenarioId(projectQuickScenarios);
    if (quickDefault && inDisplay(quickDefault)) {
      setSelectedScenarioId(quickDefault);
      return;
    }
    const def = boundScenarios.find((b) => b.enabled === 1 && b.is_default === 1);
    if (def?.scenario_id && inDisplay(def.scenario_id)) {
      setSelectedScenarioId(def.scenario_id);
      return;
    }
    const firstExecutable = workshopDisplayScenarios.find((s) => isWorkshopExecutable(s));
    setSelectedScenarioId(firstExecutable?.id ?? workshopDisplayScenarios[0]?.id ?? "");
  }, [
    selectedProjectId,
    loadingBound,
    workshopDisplayScenarios,
    scenarioFromUrl,
    selectedScenarioId,
    boundScenarios,
    projectQuickScenarios,
    isWorkshopExecutable,
  ]);

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

  useEffect(() => {
    setErrorMsg("");
    setGenStatus((s) => (s === "error" ? "idle" : s));
  }, [selectedProjectId, selectedScenarioId]);

  const parsedScenarioSkills = useMemo(
    () =>
      parseScenarioSkills(scenarioDetail?.skills_policy, scenarioDetail?.output_policy),
    [scenarioDetail],
  );

  const runSkillNames = parsedScenarioSkills.runSkillNames;

  const scenarioSkillBindings = useMemo((): (ScenarioSkillBinding & {
    displayName: string;
    description: string;
    resolvedTemplateLabel?: string;
  })[] => {
    return parsedScenarioSkills.bindings.map((b) => {
      const meta = skillMeta.find((m) => m.name === b.name);
      const tpl =
        b.templatePath && meta
          ? meta.templates.find((t) => t.path === b.templatePath)
          : undefined;
      return {
        ...b,
        displayName: meta?.display_name?.trim() || b.name,
        description: meta?.description?.trim() || "",
        resolvedTemplateLabel: b.templateLabel ?? tpl?.label,
      };
    });
  }, [parsedScenarioSkills.bindings, skillMeta]);

  useEffect(() => {
    if (runSkillNames.length === 0) {
      setSelectedSkill(null);
      return;
    }
    if (runSkillNames.length === 1) {
      setSelectedSkill(runSkillNames[0]);
      return;
    }
    setSelectedSkill((prev) =>
      prev && runSkillNames.includes(prev) ? prev : runSkillNames[0] ?? null,
    );
  }, [runSkillNames]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const derivedTaskTitle = useMemo(() => {
    const projectName = selectedProject?.name?.trim() || "项目";
    const scenarioName =
      workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "场景";
    const skillPart = selectedSkill ?? runSkillNames[0] ?? "技能";
    return `${projectName} · ${scenarioName} · ${skillPart}`;
  }, [
    selectedProject?.name,
    workshopScenarioOptions,
    selectedScenarioId,
    selectedSkill,
    runSkillNames,
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
      { label: "工作模式", value: workshopModeLabel(mode) },
      { label: "关联项目", value: selectedProject?.name ?? "请先选择项目" },
      {
        label: "场景",
        value:
          workshopScenarioOptions.find((o) => o.id === selectedScenarioId)?.name ?? "—",
      },
      {
        label: "绑定技能",
        value:
          runSkillNames.length === 0
            ? skillsPolicyModeLabel(parsedScenarioSkills.mode) || "未绑定"
            : runSkillNames.length === 1
              ? scenarioSkillBindings.find((b) => b.name === runSkillNames[0])?.displayName ??
                runSkillNames[0]
              : selectedSkill ?? runSkillNames[0] ?? "请选择",
      },
    ],
    [
      mode,
      selectedProject?.name,
      workshopScenarioOptions,
      selectedScenarioId,
      runSkillNames,
      selectedSkill,
      parsedScenarioSkills.mode,
      scenarioSkillBindings,
    ],
  );

  const agentExecutePreview = useMemo(() => {
    const scenarioOpt = workshopScenarioOptions.find((o) => o.id === selectedScenarioId);
    const scenarioLabel = scenarioOpt?.name ?? (selectedScenarioId || "—");
    const scenarioVersion = scenarioOpt?.versionLine;
    const scenarioLine = scenarioVersion ? `${scenarioLabel} · ${scenarioVersion}` : scenarioLabel;
    const skillRun = selectedSkill ?? runSkillNames[0] ?? "";
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
        { k: "工作模式", v: workshopModeLabel(mode) },
        { k: fieldLabel("entrypoint"), v: entrypointLabel("workshop") },
      ],
      step2Rows: [
        { k: fieldLabel("project_id"), v: selectedProjectId || "（未选择）" },
        { k: fieldLabel("project_name"), v: selectedProject?.name ?? "—" },
        { k: "项目状态", v: projectStatusLabel(selectedProject?.status) },
      ],
      step3Rows: [
        { k: fieldLabel("scenario_id"), v: selectedScenarioId || "（未选择）" },
        { k: "场景 / 版本", v: scenarioLine },
        { k: "执行技能", v: skillRun || "（合同未配置或待选）" },
        { k: "场景合同摘要", v: contractSlice },
        {
          k: fieldLabel("overrides.skills"),
          v: skillsOverrideSummary(skillRun),
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
    runSkillNames,
    workshopScenarioOptions,
    contractSummaryText,
  ]);

  const outputArtifactFormat = useMemo((): WorkshopOutputFormat => {
    if (savedOutputFormat) return savedOutputFormat;
    return formatFromOutputPolicy(scenarioDetail?.output_policy);
  }, [savedOutputFormat, scenarioDetail?.output_policy]);

  useEffect(() => {
    if (!selectedProjectId || !lastRunMeta?.output_id) {
      setSavedOutputFormat(null);
      return;
    }
    let cancelled = false;
    apiGet<{ content_format: string }>(
      `/projects/${selectedProjectId}/outputs/${lastRunMeta.output_id}`,
    )
      .then((d) => {
        if (!cancelled) setSavedOutputFormat(normalizeWorkshopOutputFormat(d.content_format));
      })
      .catch(() => {
        if (!cancelled) setSavedOutputFormat(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, lastRunMeta?.output_id]);

  const outputArtifacts = useMemo(
    () =>
      deriveWorkshopArtifacts(
        output,
        outputArtifactFormat,
        taskTitleCustom.trim() || derivedTaskTitle,
      ),
    [output, outputArtifactFormat, taskTitleCustom, derivedTaskTitle],
  );

  const handleSubmit = useCallback(() => {
    if (!selectedProjectId) {
      alert("请先选择项目；场景输出需在项目上下文中执行。");
      return;
    }
    if (!selectedScenarioId || loadingBound) {
      alert("请等待场景列表加载完成并选择场景");
      return;
    }
    const selectedItem = scenarioListItems.find((s) => s.id === selectedScenarioId);
    if (!selectedItem || !isWorkshopExecutable(selectedItem)) {
      alert("当前场景未绑定本项目。请先在项目详情「设置快捷场景」中勾选并保存，或选择已绑定的场景。");
      return;
    }
    if (loadingScenarioDetail || !scenarioDetail) {
      alert("场景合同加载中，请稍候");
      return;
    }
    if (runSkillNames.length === 0) {
      alert(
        "当前场景未绑定可执行技能。请在「场景编排」中开启强制绑定技能并选择技能包，或配置输出模版对应技能后重新发布。",
      );
      return;
    }
    const skillForRun =
      runSkillNames.length === 1 ? runSkillNames[0] : selectedSkill ?? runSkillNames[0];
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
      user_id: scopeUserId,
      source_output_id: mode === "refine" && sourceOutputId ? sourceOutputId : null,
      overrides: {
        skills: {
          mode: "manual_only",
          allowed: [skillForRun],
          allow_agent_free_choice: false,
        },
      },
    };

    apiFetch("/tasks/execute", {
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
    runSkillNames,
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
    scopeUserId,
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

        <section className="grid gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="w-full min-w-0 space-y-6 xl:max-w-[22rem]">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(1)}</p>
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
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(2)}</p>
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
                        <dd className="mt-0.5 text-slate-200">
                          {projectStatusLabel(selectedProject.status)}
                        </dd>
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
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(3)}</p>
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
                  请先选择项目；将展示全部已发布场景，并默认选中项目快捷场景。
                </p>
              ) : (
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <span className="text-slate-300">已发布场景（与场景编排同源）</span>
                  <span className="text-xs text-slate-500">
                    服务端 {remoteScenarios.length} · 内置模板 {localTemplateCount}
                  </span>
                </div>
                {loadingBound ? (
                  <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-6 text-center text-sm text-slate-500">
                    加载项目绑定…
                  </p>
                ) : (
                  <div className="grid max-h-[min(22rem,50vh)] gap-3 overflow-y-auto pr-1">
                    {workshopDisplayScenarios.map((scenario) => {
                      const active = scenario.id === selectedScenarioId;
                      const binding = boundByScenarioId.get(scenario.id);
                      const executable = isWorkshopExecutable(scenario);
                      const isQuick = quickScenarioIdSet.has(scenario.id);
                      const remote = scenario.remote;
                      return (
                        <button
                          key={scenario.id}
                          type="button"
                          onClick={() => setSelectedScenarioId(scenario.id)}
                          className={`rounded-2xl border p-4 text-left transition ${
                            active
                              ? "border-blue-500 bg-blue-500/10"
                              : executable
                                ? "border-slate-700 bg-slate-950/60 hover:border-slate-600"
                                : "border-slate-800 bg-slate-950/40 hover:border-slate-700"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="font-semibold text-white">{scenario.title}</h3>
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                active ? "bg-blue-400" : executable ? "bg-emerald-500/80" : "bg-slate-600"
                              }`}
                            />
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-slate-400">{scenario.summary}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {remote ? (
                              <span className="rounded-full border border-emerald-700/50 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200">
                                {scenarioStatusLabel(remote.status)} · v{remote.version}
                              </span>
                            ) : null}
                            {scenario.isLocalTemplate ? (
                              <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] text-slate-400">
                                内置模板
                              </span>
                            ) : null}
                            {isQuick ? (
                              <span className="rounded-full border border-violet-600/50 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-200">
                                快捷场景
                                {projectQuickScenarios?.defaultScenarioId === scenario.id
                                  ? " · 默认"
                                  : ""}
                              </span>
                            ) : null}
                            {binding?.enabled === 1 ? (
                              <span className="rounded-full border border-blue-600/50 bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-200">
                                已绑定{binding.is_default && !isQuick ? " · 默认" : ""}
                              </span>
                            ) : (
                              <span className="rounded-full border border-amber-700/50 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                                未绑定本项目
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedProjectId && !loadingBound && workshopDisplayScenarios.length === 0 ? (
                  <p className="text-xs text-amber-400/90">
                    暂无已发布场景。请先在{" "}
                    <Link href="/create" className="underline">
                      场景编排
                    </Link>{" "}
                    发布场景，再到{" "}
                    <Link href={`/projects/${selectedProjectId}`} className="underline">
                      项目详情
                    </Link>{" "}
                    设置快捷场景。
                  </p>
                ) : null}
                {selectedProjectId &&
                !loadingBound &&
                workshopDisplayScenarios.length > 0 &&
                workshopScenarioOptions.length === 0 ? (
                  <p className="text-xs text-amber-400/90">
                    已有已发布场景，但均未绑定本项目。请在项目详情「设置快捷场景」中勾选并保存后再执行。
                  </p>
                ) : null}
                {selectedProjectId && !loadingBound && workshopDisplayScenarios.length > 0 ? (
                  <p className="text-xs text-slate-500">
                    列表为全部已发布场景；带「快捷场景」的为项目详情中配置的默认入口。仅已绑定场景可执行生成。
                  </p>
                ) : null}
              </div>
              )}

              {selectedScenarioId && scenarioDetail ? (
                <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">场景合同（服务端）</p>
                  <p className="mt-2 text-base font-semibold text-white">{scenarioDetail.name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    场景编码 · <span className="font-mono text-slate-400">{scenarioDetail.code}</span>
                  </p>
                  {scenarioDetail.description?.trim() ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">
                      {scenarioDetail.description}
                    </p>
                  ) : null}
                  <details className="mt-4 group border-t border-slate-800 pt-3">
                    <summary className="cursor-pointer text-xs text-slate-400 transition hover:text-slate-200">
                      {POLICY_SECTION_SUMMARY}
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
                <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">场景绑定技能</p>
                    <p className="mt-1 text-sm text-slate-400">
                      来自场景编排中的技能绑定与输出模版配置
                    </p>
                  </div>
                  {scenarioDetail && !loadingScenarioDetail ? (
                    <Link
                      href={`/create?return_project_id=${encodeURIComponent(selectedProjectId)}`}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      去场景编排调整 →
                    </Link>
                  ) : null}
                </div>

                {loadingScenarioDetail || (selectedScenarioId && !scenarioDetail) ? (
                  <p className="py-6 text-center text-sm text-slate-400">加载场景合同…</p>
                ) : (
                  <ScenarioSkillsBlock
                    parsed={parsedScenarioSkills}
                    bindings={scenarioSkillBindings}
                    runSkillNames={runSkillNames}
                    selectedSkill={selectedSkill}
                    onSelectSkill={setSelectedSkill}
                  />
                )}
              </div>
            </div>

          </div>

          <aside className="min-h-0 xl:sticky xl:top-6 xl:self-start">
            <div className="grid gap-6 xl:grid-cols-2">
            <div className="min-h-0 rounded-3xl border border-slate-800 bg-slate-900/50 p-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(4)}</p>
              <h2 className="mt-2 text-xl font-semibold">任务信息</h2>
              <p className="mt-1 text-sm text-slate-500">
                以下为本次任务输入，将并入编排与技能上下文；标题留空则使用自动摘要。
              </p>

              <div className="mt-4 grid grid-cols-1 gap-3">
                <label className="block space-y-1.5 text-sm">
                  <span className="text-slate-400">任务标题</span>
                  <input
                    type="text"
                    value={taskTitleCustom}
                    onChange={(e) => setTaskTitleCustom(e.target.value)}
                    placeholder={derivedTaskTitle}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="text-slate-400">背景补充</span>
                  <textarea
                    value={taskBackground}
                    onChange={(e) => setTaskBackground(e.target.value)}
                    rows={2}
                    placeholder="业务背景、已知事实、引用材料说明等"
                    className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm text-white outline-none transition focus:border-blue-500"
                  />
                </label>
                <label className="block space-y-1.5 text-sm">
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
                <label className="block space-y-1.5 text-sm">
                  <span className="text-slate-400">附加要求</span>
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
                  优化来源输出 ID：<span className="font-mono">{sourceOutputId}</span>
                  ，已作为本轮的来源输出与来源素材参与编排。
                </p>
              ) : null}

              <div className="mt-5 space-y-4">
                <details className="group rounded-2xl border border-slate-800 bg-slate-950/40 p-4 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="cursor-pointer list-none outline-none marker:content-none">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-[0.16em] text-slate-500">编排下发汇总</p>
                        <p className="mt-1 text-sm text-slate-400">
                          {stepRangeLabel(1, 3)} 对应信息；{TASK_EXECUTE_HINT}
                        </p>
                      </div>
                      <span className="shrink-0 pt-0.5 text-xs text-slate-500 transition group-open:text-slate-400">
                        <span className="group-open:hidden">展开</span>
                        <span className="hidden group-open:inline">收起</span>
                      </span>
                    </div>
                  </summary>

                  <div className="mt-4 space-y-4 border-t border-slate-800/80 pt-4">
                    {(
                      [
                        { title: stepLabel(1), subtitle: "结果处理模式", rows: agentExecutePreview.step1Rows },
                        { title: stepLabel(2), subtitle: "项目上下文", rows: agentExecutePreview.step2Rows },
                        { title: stepLabel(3), subtitle: "场景与技能", rows: agentExecutePreview.step3Rows },
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
                    <p className="text-xs font-medium text-slate-400">{taskInputSectionTitle()}</p>
                    <pre className="mt-1 max-h-28 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                      {agentExecutePreview.taskInputJson}
                    </pre>
                    <p className="mt-3 text-xs font-medium text-slate-400">{userMessageSectionTitle()}</p>
                    <pre className="mt-1 max-h-36 overflow-auto rounded-lg border border-slate-800 bg-slate-950/80 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                      {agentExecutePreview.userMessageJson}
                    </pre>
                  </div>
                </details>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">已沉淀输出</p>
                      <p className="mt-1 text-sm text-slate-400">
                        当前项目下，与{stepLabel(3)}所选场景关联的历史输出记录
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
                      该场景下尚无已沉淀输出；编排执行成功并写入后将显示在此。
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
                                {outputStatusLabel(o.status)}
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

            <section className="min-h-0 rounded-3xl border border-slate-800 bg-slate-900/50 p-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
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

              <WorkshopOutputPanel
                artifacts={outputArtifacts}
                defaultFormat={outputArtifactFormat}
                genStatus={genStatus}
                errorMsg={errorMsg}
                outputEndRef={outputEndRef}
              />
            </section>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

type EnrichedSkillBinding = ScenarioSkillBinding & {
  displayName: string;
  description: string;
  resolvedTemplateLabel?: string;
};

function ScenarioSkillsBlock({
  parsed,
  bindings,
  runSkillNames,
  selectedSkill,
  onSelectSkill,
}: {
  parsed: ParsedScenarioSkills;
  bindings: EnrichedSkillBinding[];
  runSkillNames: string[];
  selectedSkill: string | null;
  onSelectSkill: (name: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-sm">
        <span className="text-slate-500">绑定模式</span>
        <p className="mt-1 text-slate-200">
          {skillsPolicyModeLabel(parsed.mode)}
          {parsed.allowAgentFreeChoice
            ? " · 允许智能体在合同范围内自选"
            : " · 须按下列绑定执行"}
        </p>
      </div>

      {bindings.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {bindings.map((binding) => {
            const canRun = runSkillNames.includes(binding.name);
            const active = selectedSkill === binding.name;
            const sourceLabel =
              binding.source === "allowed"
                ? "强制绑定"
                : binding.source === "preferred"
                  ? "偏好"
                  : "输出模版";
            const body = (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-medium text-white">{binding.displayName}</span>
                  <span className="rounded-full border border-slate-600 px-2 py-0.5 text-[10px] text-slate-400">
                    {sourceLabel}
                  </span>
                </div>
                <p className="mt-1 font-mono text-xs text-slate-500">{binding.name}</p>
                {binding.description ? (
                  <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-slate-400">
                    {binding.description}
                  </p>
                ) : null}
                {binding.resolvedTemplateLabel || binding.templatePath ? (
                  <p className="mt-2 text-xs text-slate-400">
                    输出模版：
                    <span className="text-slate-200">
                      {binding.resolvedTemplateLabel ?? binding.templatePath}
                    </span>
                  </p>
                ) : null}
                {canRun && runSkillNames.length > 1 && active ? (
                  <span className="mt-2 block text-xs text-blue-300">将用于本次执行</span>
                ) : null}
                {canRun && runSkillNames.length === 1 ? (
                  <span className="mt-2 block text-xs text-blue-300/90">本次执行使用该技能</span>
                ) : null}
              </>
            );
            if (canRun && runSkillNames.length > 1) {
              return (
                <button
                  key={`${binding.name}-${binding.source}`}
                  type="button"
                  onClick={() => onSelectSkill(binding.name)}
                  className={`rounded-2xl border p-4 text-left text-sm transition ${
                    active
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-slate-700 bg-slate-950/60 hover:border-slate-600"
                  }`}
                >
                  {body}
                </button>
              );
            }
            return (
              <div
                key={`${binding.name}-${binding.source}`}
                className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm"
              >
                {body}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-6 text-center text-sm text-slate-400">
          本场景未强制绑定具体技能。
          {parsed.mode === "agent_select" || parsed.allowAgentFreeChoice
            ? " 若需固定技能，请在场景编排中开启「强制绑定技能」并选择技能包后发布。"
            : " 请在场景编排中配置技能或输出模版后重新发布。"}
        </p>
      )}

      {bindings.length > 0 && runSkillNames.length === 0 ? (
        <p className="text-xs text-amber-400/90">
          已展示绑定信息，但尚无可执行白名单。请在场景编排中将技能加入「强制绑定 Skill」并发布后，再在本页执行。
        </p>
      ) : null}
    </div>
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
