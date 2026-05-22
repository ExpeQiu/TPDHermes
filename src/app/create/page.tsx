"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiGet, apiFetch, apiDelete, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { SCENARIOS, type Scenario } from "@/lib/scenario-presets";
import {
  filterPublicKbCollections,
  isPublicKbCollection,
  kbCollectionLabel,
  scenarioStatusLabel,
  skillLabel,
  stepLabel,
} from "@/lib/ui-labels";
import {
  buildScenarioListItems,
  countLocalTemplates,
  DISMISSED_PRESETS_KEY,
  loadDismissedPresetIds,
  type ScenarioApiRow,
} from "@/lib/scenario-list";
import {
  accentEmeraldSoft,
  accentLink,
  btnAmberAction,
  btnDangerGhost,
  btnEmeraldAction,
  chipBlueActive,
  pillBlue,
  pillEmerald,
} from "@/lib/theme-text";
import { SkillsScopePanel, type SkillScopeItem } from "@/components/skills/SkillsScopePanel";

type SkillTemplateMeta = {
  id: string;
  label: string;
  path: string;
  tags?: string[];
  sections?: string[];
};

type SkillTemplateOption = {
  value: string;
  label: string;
  skillName: string;
};

type SkillTemplateGroup = {
  skillName: string;
  skillTitle: string;
  templates: SkillTemplateOption[];
};


type SkillMetaRow = {
  name: string;
  display_name: string;
  description: string;
  templates: SkillTemplateMeta[];
};

function formatBoundSkillNames(
  names: string[],
  displayByName: Map<string, string>,
): string {
  return names.map((name) => skillLabel(name, displayByName.get(name))).join("、");
}

function resolveTemplateOutputTags(tpl: SkillTemplateMeta | null | undefined): string[] {
  if (!tpl) return [];
  if (tpl.tags?.length) return tpl.tags;
  if (tpl.sections?.length) return tpl.sections;
  return [];
}

function resolveTemplateContractSections(tpl: SkillTemplateMeta | null | undefined): string[] {
  if (!tpl) return [];
  if (tpl.sections?.length) return tpl.sections;
  if (tpl.tags?.length) return tpl.tags;
  return [];
}

type ScenarioDetail = {
  id: string;
  goal: string | null;
  description: string | null;
  preset_instructions: string | null;
  knowledge_policy: Record<string, unknown>;
  skills_policy: Record<string, unknown>;
  output_policy: Record<string, unknown>;
};

const SKILL_TEMPLATE_SEP = "::";

function encodeSkillTemplate(skillName: string, templatePath: string): string {
  return `${skillName}${SKILL_TEMPLATE_SEP}${templatePath}`;
}

function decodeSkillTemplate(value: string): { skillName: string; templatePath: string } | null {
  const i = value.indexOf(SKILL_TEMPLATE_SEP);
  if (i <= 0) return null;
  return { skillName: value.slice(0, i), templatePath: value.slice(i + SKILL_TEMPLATE_SEP.length) };
}

const DEFAULT_SCENARIO_ID = SCENARIOS[0]?.id ?? "general";

export default function CreatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
          加载场景编排...
        </div>
      }
    >
      <CreatePageInner />
    </Suspense>
  );
}

function CreatePageInner() {
  const searchParams = useSearchParams();
  const returnProjectId = searchParams?.get("return_project_id")?.trim() ?? "";

  const [collections, setCollections] = useState<string[]>([]);
  const [installedSkills, setInstalledSkills] = useState<SkillScopeItem[]>([]);
  const [skillMeta, setSkillMeta] = useState<SkillMetaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenarioId, setSelectedScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [remoteList, setRemoteList] = useState<ScenarioApiRow[]>([]);

  const [sceneDescription, setSceneDescription] = useState("");
  const [resultDescription, setResultDescription] = useState("");
  const [forceBindSkill, setForceBindSkill] = useState(false);
  const [forceBindKb, setForceBindKb] = useState(false);
  const [contractAllowedSkills, setContractAllowedSkills] = useState<string[]>([]);
  const [selectedKbKeys, setSelectedKbKeys] = useState<string[]>([]);
  const [selectedSkillTemplate, setSelectedSkillTemplate] = useState("");

  const [previewText, setPreviewText] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newScenarioName, setNewScenarioName] = useState("");
  const [newScenarioCode, setNewScenarioCode] = useState("");
  const [newScenarioDesc, setNewScenarioDesc] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [dismissedPresetIds, setDismissedPresetIds] = useState<Set<string>>(loadDismissedPresetIds);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiGet<{ collections: string[] }>("/kb/collections"),
      apiFetch("/skills/").then((res) => readJson<SkillScopeItem[]>(res)),
      apiGet<{ skills: SkillMetaRow[] }>("/ws/skills/metadata"),
    ]).then(([collectionsRes, skillsRes, metaRes]) => {
      if (cancelled) return;
      const nextCollections =
        collectionsRes.status === "fulfilled" ? collectionsRes.value.collections : [];
      const nextSkills = skillsRes.status === "fulfilled" ? skillsRes.value : [];
      const nextMeta = metaRes.status === "fulfilled" ? metaRes.value.skills : [];
      setCollections(nextCollections);
      setInstalledSkills(nextSkills);
      setSkillMeta(nextMeta);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    apiGet<ScenarioApiRow[]>("/scenarios/")
      .then(setRemoteList)
      .catch(() => setRemoteList([]));
  }, []);

  const remoteById = useMemo(
    () => new Map(remoteList.map((r) => [r.id, r] as const)),
    [remoteList],
  );

  const publicCollections = useMemo(
    () => filterPublicKbCollections(collections),
    [collections],
  );

  useEffect(() => {
    setSelectedKbKeys((prev) => {
      const next = prev.filter((k) => publicCollections.includes(k));
      return next.length === prev.length ? prev : next;
    });
  }, [publicCollections]);

  useEffect(() => {
    const installed = new Set(installedSkills.map((s) => s.name));
    setContractAllowedSkills((prev) => {
      const next = prev.filter((name) => installed.has(name));
      return next.length === prev.length ? prev : next;
    });
  }, [installedSkills]);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const cols = publicCollections;
    const sid = selectedScenarioId;

    (async () => {
      try {
        setSaveMessage("");
        const row = await apiGet<ScenarioDetail>(`/scenarios/${sid}`);
        if (cancelled) return;

        const localCard = SCENARIOS.find((s) => s.id === sid);

        setSceneDescription((row.description ?? "").trim() || localCard?.summary || "");
        setResultDescription((row.goal ?? "").trim() || localCard?.goal || "");

        const kp = row.knowledge_policy ?? {};
        const rawCols = Array.isArray(kp.collections) ? (kp.collections as string[]) : [];
        const publicRawCols = filterPublicKbCollections(
          rawCols.map((c) => String(c).trim()).filter(Boolean),
        );
        const modeK = typeof kp.mode === "string" ? kp.mode : "restricted";
        const intersect = publicRawCols.filter((c) => cols.includes(c));
        const knowledgeOn =
          intersect.length > 0 ||
          publicRawCols.length > 0 ||
          (modeK !== "off" && modeK !== "none" && modeK !== "disabled");
        setForceBindKb(knowledgeOn);
        if (intersect.length > 0) setSelectedKbKeys(intersect);
        else if (publicRawCols.length > 0) setSelectedKbKeys(publicRawCols);
        else if (knowledgeOn && cols.length > 0) setSelectedKbKeys(cols.slice());
        else setSelectedKbKeys([]);

        const sp = row.skills_policy ?? {};
        const allowedRaw = Array.isArray(sp.allowed) ? (sp.allowed as unknown[]) : [];
        const allowedNorm = allowedRaw.map((x) => String(x).trim()).filter(Boolean);
        const mode = typeof sp.mode === "string" ? sp.mode : "";
        setForceBindSkill(mode === "allowed_list" || allowedNorm.length > 0);
        setContractAllowedSkills(allowedNorm);

        const op = row.output_policy ?? {};
        const skillName = typeof op.skill_name === "string" ? op.skill_name : "";
        const skillTpl = typeof op.skill_template === "string" ? op.skill_template : "";
        if (skillName && skillTpl) {
          setSelectedSkillTemplate(encodeSkillTemplate(skillName, skillTpl));
        } else {
          setSelectedSkillTemplate("");
        }

      } catch {
        if (cancelled) return;
        const local = SCENARIOS.find((s) => s.id === sid);
        setSceneDescription(local?.summary ?? "");
        setResultDescription(local?.goal ?? "");
        setForceBindKb(false);
        setSelectedKbKeys([]);
        setForceBindSkill(false);
        setContractAllowedSkills([]);
        setSelectedSkillTemplate("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedScenarioId, loading, publicCollections, remoteList]);

  const scenarioListItems = useMemo(
    () => buildScenarioListItems(remoteList, dismissedPresetIds),
    [remoteList, dismissedPresetIds],
  );

  const localTemplateCount = useMemo(
    () => countLocalTemplates(remoteList, dismissedPresetIds),
    [remoteList, dismissedPresetIds],
  );

  const selectedScenario = useMemo(() => {
    const fromList = scenarioListItems.find((s) => s.id === selectedScenarioId);
    if (fromList) return fromList;
    return scenarioListItems[0] ?? SCENARIOS[0];
  }, [selectedScenarioId, scenarioListItems]);

  const skillDisplayByName = useMemo(
    () => new Map(skillMeta.map((m) => [m.name, m.display_name] as const)),
    [skillMeta],
  );

  const skillTemplateGroups = useMemo((): SkillTemplateGroup[] => {
    if (!forceBindSkill || contractAllowedSkills.length === 0) return [];
    const groups: SkillTemplateGroup[] = [];
    const seen = new Set<string>();
    for (const skillName of contractAllowedSkills) {
      const meta = skillMeta.find((m) => m.name === skillName);
      const templates: SkillTemplateOption[] = [];
      for (const t of meta?.templates ?? []) {
        const value = encodeSkillTemplate(skillName, t.path);
        if (seen.has(value)) continue;
        seen.add(value);
        templates.push({
          value,
          label: t.label,
          skillName,
        });
      }
      groups.push({
        skillName,
        skillTitle: skillLabel(skillName, meta?.display_name),
        templates,
      });
    }
    return groups;
  }, [forceBindSkill, contractAllowedSkills, skillMeta]);

  const skillTemplateOptions = useMemo(
    () => skillTemplateGroups.flatMap((group) => group.templates),
    [skillTemplateGroups],
  );

  const boundSkillTitles = useMemo(
    () => formatBoundSkillNames(contractAllowedSkills, skillDisplayByName),
    [contractAllowedSkills, skillDisplayByName],
  );

  const skillsWithoutTemplates = useMemo(
    () => skillTemplateGroups.filter((group) => group.templates.length === 0).map((g) => g.skillTitle),
    [skillTemplateGroups],
  );

  useEffect(() => {
    if (!selectedSkillTemplate) return;
    if (!skillTemplateOptions.some((o) => o.value === selectedSkillTemplate)) {
      setSelectedSkillTemplate("");
    }
  }, [skillTemplateOptions, selectedSkillTemplate]);

  const kbOrdered = useMemo(
    () => publicCollections.filter((c) => selectedKbKeys.includes(c)),
    [publicCollections, selectedKbKeys],
  );

  const decodedTemplate = useMemo(
    () => (selectedSkillTemplate ? decodeSkillTemplate(selectedSkillTemplate) : null),
    [selectedSkillTemplate],
  );

  const selectedTemplateMeta = useMemo((): SkillTemplateMeta | null => {
    if (!decodedTemplate) return null;
    const skill = skillMeta.find((m) => m.name === decodedTemplate.skillName);
    return skill?.templates.find((t) => t.path === decodedTemplate.templatePath) ?? null;
  }, [decodedTemplate, skillMeta]);

  const outputTags = useMemo(
    () => resolveTemplateOutputTags(selectedTemplateMeta),
    [selectedTemplateMeta],
  );

  const contractSections = useMemo(
    () => resolveTemplateContractSections(selectedTemplateMeta),
    [selectedTemplateMeta],
  );

  function toggleKb(name: string) {
    if (!forceBindKb || !isPublicKbCollection(name)) return;
    setSelectedKbKeys((prev) => {
      if (prev.includes(name)) {
        if (prev.length <= 1) return prev;
        return prev.filter((x) => x !== name);
      }
      return [...prev, name];
    });
  }

  function toggleSkill(name: string) {
    if (!forceBindSkill) return;
    setContractAllowedSkills((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    );
  }

  async function runServerPreview() {
    if (!selectedScenarioId) return;
    setPreviewBusy(true);
    try {
      const res = await apiFetch(`/scenarios/${selectedScenarioId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: null,
          user_message: "（编排预览）",
        }),
      });
      const data = await readJson<unknown>(res);
      setPreviewText(JSON.stringify(data, null, 2));
      console.info("[create] 编排预览", { scenario_id: selectedScenarioId });
    } catch (e) {
      setPreviewText(e instanceof Error ? e.message : "预览失败");
    } finally {
      setPreviewBusy(false);
    }
  }

  function openAddScenarioModal() {
    setAddError("");
    setNewScenarioName("");
    setNewScenarioCode(`custom-${Date.now().toString(36)}`);
    setNewScenarioDesc("");
    setAddOpen(true);
  }

  async function submitNewScenario() {
    const name = newScenarioName.trim();
    const code = newScenarioCode.trim().replace(/\s+/g, "-");
    if (!name) {
      setAddError("请填写场景名称");
      return;
    }
    if (!code) {
      setAddError("请填写场景编码");
      return;
    }
    setAddBusy(true);
    setAddError("");
    try {
      const res = await apiFetch("/scenarios/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name,
          description: newScenarioDesc.trim() || null,
          goal: "待补充结果说明",
          conversation_mode: "task_oriented",
          domain: {},
          knowledge_policy: { mode: "restricted", collections: [], project_bound: false, top_k: 5 },
          skills_policy: { mode: "agent_select", allowed: [], preferred: [], allow_agent_free_choice: true },
          output_policy: { format: "markdown", required_sections: [], must_follow_template: false },
        }),
      });
      const created = await readJson<{ id: string }>(res);
      const next = await apiGet<ScenarioApiRow[]>("/scenarios/").catch(() => null);
      if (next) setRemoteList(next);
      setSelectedScenarioId(created.id);
      setAddOpen(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setAddBusy(false);
    }
  }

  async function persistScenarioDraftToServer(): Promise<{ scenarioId: string; createdNew: boolean }> {
    if (!selectedScenario) throw new Error("未选择场景");

    const presetInstructions = [
      `【场景说明】\n${sceneDescription.trim() || selectedScenario.summary}`,
      `【结果说明】\n${resultDescription.trim() || selectedScenario.goal}`,
      selectedTemplateMeta
        ? `【输出模版】${selectedTemplateMeta.label}`
        : null,
      contractSections.length > 0 ? `【模版标签】${contractSections.join("、")}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const knowledge_policy = {
      mode: forceBindKb ? "restricted" : "off",
      collections: forceBindKb ? kbOrdered : [],
      project_bound: false,
      top_k: 5,
      fallback_policy: "cache_allowed",
    };

    const skills_policy = {
      mode: forceBindSkill ? "allowed_list" : "agent_select",
      allowed: forceBindSkill ? contractAllowedSkills : [],
      preferred: forceBindSkill && contractAllowedSkills[0] ? [contractAllowedSkills[0]] : [],
      forbidden: [] as string[],
      allow_agent_free_choice: !forceBindSkill,
    };

    const output_policy: Record<string, unknown> = {
      format: "markdown",
      must_follow_template: Boolean(decodedTemplate),
      required_sections: contractSections,
      validation_rules: { must_have_headings: true, must_cite_sources: forceBindKb },
      template_id: null,
    };
    if (decodedTemplate) {
      output_policy.skill_name = decodedTemplate.skillName;
      output_policy.skill_template = decodedTemplate.templatePath;
    }

    const updateBody = {
      goal: resultDescription.trim() || selectedScenario.goal,
      description: sceneDescription.trim() || selectedScenario.summary,
      preset_instructions: presetInstructions,
      knowledge_policy,
      skills_policy,
      output_policy,
    };

    let createdNew = false;
    let res = await apiFetch(`/scenarios/${selectedScenario.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updateBody),
    });

    if (res.status === 404) {
      createdNew = true;
      const code = `qc-${selectedScenario.id}-${Date.now().toString(36)}`;
      res = await apiFetch("/scenarios/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name: `${selectedScenario.title}（编排）`,
          conversation_mode: "task_oriented",
          domain: {},
          ...updateBody,
        }),
      });
    }

    const saved = await readJson<{ id?: string }>(res);
    const scenarioId = saved.id ?? selectedScenario.id;
    if (saved.id && saved.id !== selectedScenario.id) {
      setSelectedScenarioId(saved.id);
    }
    return { scenarioId, createdNew };
  }

  async function saveScenarioDraft() {
    setSaveBusy(true);
    setSaveMessage("");
    try {
      const { createdNew, scenarioId } = await persistScenarioDraftToServer();
      setSaveMessage(createdNew ? `已新建场景 ${scenarioId}` : "场景编排已保存");
      console.info("[create] 场景保存", { scenario_id: scenarioId, createdNew });
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaveBusy(false);
      apiGet<ScenarioApiRow[]>("/scenarios/").then(setRemoteList).catch(() => {});
    }
  }

  async function publishScenario() {
    setPublishBusy(true);
    setSaveMessage("");
    try {
      const { scenarioId } = await persistScenarioDraftToServer();
      const pub = await apiFetch(`/scenarios/${scenarioId}/publish`, { method: "POST" });
      await readJson(pub);
      setSaveMessage("已保存并发布，可在项目详情中绑定该场景。");
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "发布失败");
    } finally {
      setPublishBusy(false);
      apiGet<ScenarioApiRow[]>("/scenarios/").then(setRemoteList).catch(() => {});
    }
  }

  const remoteStatus = remoteById.get(selectedScenarioId);
  const canDeleteServerScenario = Boolean(remoteById.get(selectedScenarioId));

  async function deleteSelectedScenario() {
    const row = remoteById.get(selectedScenarioId);
    if (!row) {
      setSaveMessage("当前场景无服务端记录，无法删除（本地预设仍保留）");
      return;
    }
    const bindHint =
      "删除后项目中的绑定关系将一并解除，且不可恢复。";
    if (!window.confirm(`确定删除服务端场景「${row.name}」？\n${bindHint}`)) {
      return;
    }
    setDeleteBusy(true);
    setSaveMessage("");
    try {
      const res = await apiDelete<{
        ok: boolean;
        name?: string;
        project_bindings_removed?: number;
      }>(`/scenarios/${selectedScenarioId}`);
      console.info("[create] 场景删除", {
        scenario_id: selectedScenarioId,
        bindings: res.project_bindings_removed,
      });
      const deletedId = selectedScenarioId;
      const next = await apiGet<ScenarioApiRow[]>("/scenarios/");
      setRemoteList(next);
      setDismissedPresetIds((prev) => {
        const merged = new Set(prev);
        merged.add(deletedId);
        if (typeof window !== "undefined") {
          sessionStorage.setItem(DISMISSED_PRESETS_KEY, JSON.stringify([...merged]));
        }
        return merged;
      });
      const remoteIds = new Set(next.map((r) => r.id));
      const remaining = buildScenarioListItems(next, new Set([...dismissedPresetIds, deletedId]));
      if (!remoteIds.has(deletedId)) {
        setSelectedScenarioId(remaining[0]?.id ?? DEFAULT_SCENARIO_ID);
      }
      const removed = res.project_bindings_removed ?? 0;
      setSaveMessage(
        removed > 0
          ? `已删除「${res.name ?? row.name}」，并解除 ${removed} 处项目绑定`
          : `已删除「${res.name ?? row.name}」`,
      );
    } catch (e) {
      setSaveMessage(e instanceof Error ? e.message : "删除失败");
      console.warn("[create] 场景删除失败", e);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <header className="mb-8">
          <Link href="/" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
            ← 返回首页
          </Link>
          <div className={`mt-3 inline-flex items-center gap-2 px-3 py-1 text-xs ${pillBlue}`}>
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            场景编排
          </div>
          <h1 className="mt-4 text-3xl font-bold sm:text-4xl">场景编排</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            定义场景合同：场景说明、结果说明、可选绑定技能/知识库与输出模版。本页仅预览合同与保存发布，不在此生成正文。
          </p>
        </header>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* Step 1: 场景列表 */}
          <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(1)}</p>
                <h2 className="mt-2 text-xl font-semibold">场景列表</h2>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={openAddScenarioModal}
                  disabled={deleteBusy}
                  className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-200/80 dark:bg-slate-800/80 px-3 py-1.5 text-xs font-medium hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-50"
                >
                  新增
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSelectedScenario()}
                  disabled={deleteBusy || !canDeleteServerScenario}
                  title={
                    canDeleteServerScenario
                      ? "删除当前选中的服务端场景"
                      : "仅本地预设或无服务端记录时不可删"
                  }
                  className={`rounded-xl px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${btnDangerGhost}`}
                >
                  {deleteBusy ? "删除中…" : "删除"}
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              服务端 {remoteList.length} · 内置模板 {localTemplateCount}
            </p>
            <div className="mt-4 grid gap-3">
              {scenarioListItems.length === 0 ? (
                <p className="text-sm text-slate-500">暂无场景，可点击「新增」创建。</p>
              ) : (
                scenarioListItems.map((scenario) => {
                  const active = scenario.id === selectedScenarioId;
                  const remote = scenario.remote;
                  const isLocalTemplate = scenario.isLocalTemplate;
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      onClick={() => setSelectedScenarioId(scenario.id)}
                      className={`rounded-2xl border p-4 text-left transition ${
                        active
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-950/60 hover:border-slate-300 dark:border-slate-600"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold">{scenario.title}</h3>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-blue-400" : "bg-slate-600"}`}
                        />
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-400">{scenario.summary}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {remote ? (
                          <span className={`px-2 py-0.5 text-[10px] ${pillEmerald}`}>
                            {scenarioStatusLabel(remote.status)} · v{remote.version}
                          </span>
                        ) : null}
                        {isLocalTemplate ? (
                          <span className="rounded-full border border-slate-300 dark:border-slate-600 px-2 py-0.5 text-[10px] text-slate-400">
                            内置模板
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Step 2: 场景配置 */}
          <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(2)}</p>
            <h2 className="mt-2 text-xl font-semibold">场景配置</h2>

            <div className="mt-5 space-y-4">
              <label className="block space-y-2 text-sm">
                <span className="text-slate-700 dark:text-slate-300">场景说明（输入）</span>
                <textarea
                  value={sceneDescription}
                  onChange={(e) => setSceneDescription(e.target.value)}
                  rows={4}
                  placeholder="描述本场景的业务背景、约束与输入材料…"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-4 py-3 text-sm outline-none focus:border-blue-500"
                />
              </label>

              <label className="block space-y-2 text-sm">
                <span className="text-slate-700 dark:text-slate-300">结果说明（输出）</span>
                <textarea
                  value={resultDescription}
                  onChange={(e) => setResultDescription(e.target.value)}
                  rows={3}
                  placeholder="描述期望交付物形态、用途与质量标准…"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-4 py-3 text-sm outline-none focus:border-blue-500"
                />
              </label>

              <div className="space-y-2 text-sm">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-slate-700 dark:text-slate-300">强制绑定知识库（可选）</span>
                  <input
                    type="checkbox"
                    checked={forceBindKb}
                    onChange={(e) => {
                      setForceBindKb(e.target.checked);
                      if (!e.target.checked) setSelectedKbKeys([]);
                      else setSelectedKbKeys(publicCollections.slice());
                    }}
                    aria-label="强制绑定知识库"
                  />
                </label>
                <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 p-4">
                {forceBindKb ? (
                  publicCollections.length === 0 ? (
                    <p className="text-xs text-slate-500">暂无公共知识库集合</p>
                  ) : (
                  <ul className="max-h-32 space-y-2 overflow-y-auto">
                    {publicCollections.map((name) => (
                      <li key={name}>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selectedKbKeys.includes(name)}
                            onChange={() => toggleKb(name)}
                          />
                          <span title={name}>{kbCollectionLabel(name)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  )
                ) : (
                  <p className="text-xs text-slate-500">未开启时不限制知识集合</p>
                )}
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <label className="flex items-center justify-between gap-3">
                  <span className="text-slate-700 dark:text-slate-300">强制绑定技能（可选）</span>
                  <input
                    type="checkbox"
                    checked={forceBindSkill}
                    onChange={(e) => {
                      setForceBindSkill(e.target.checked);
                      if (!e.target.checked) {
                        setContractAllowedSkills([]);
                        setSelectedSkillTemplate("");
                      }
                    }}
                    aria-label="强制绑定技能"
                  />
                </label>
                {forceBindSkill ? (
                  <SkillsScopePanel
                    skills={installedSkills}
                    loading={loading}
                    mode="select"
                    selectedNames={contractAllowedSkills}
                    onToggleSelect={toggleSkill}
                    displayNameByName={skillDisplayByName}
                  />
                ) : (
                  <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4">
                    <p className="text-xs text-slate-500">未开启时由智能体按场景自选技能</p>
                  </div>
                )}
              </div>

              <label className="block space-y-2 text-sm">
                <span className="text-slate-700 dark:text-slate-300">
                  输出模版（来自上方已选绑定技能）
                </span>
                <select
                  value={selectedSkillTemplate}
                  onChange={(e) => setSelectedSkillTemplate(e.target.value)}
                  disabled={!forceBindSkill || contractAllowedSkills.length === 0 || skillTemplateOptions.length === 0}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-4 py-3 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
                >
                  <option value="">不指定模版</option>
                  {skillTemplateGroups.map((group) =>
                    group.templates.length > 0 ? (
                      <optgroup key={group.skillName} label={`${group.skillTitle}（${group.skillName}）`}>
                        {group.templates.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null,
                  )}
                </select>
                {!forceBindSkill ? (
                  <p className="text-xs text-slate-500">请先开启「强制绑定技能」并在上方选择技能</p>
                ) : contractAllowedSkills.length === 0 ? (
                  <p className="text-xs text-slate-500">请先在上方选择要绑定的技能，模版选项将来自所选技能的 skill.json 配置</p>
                ) : skillTemplateOptions.length === 0 ? (
                  <p className="text-xs text-amber-400/90">
                    已选技能「{boundSkillTitles}」未配置输出模版，请在技能包中补充 skill.json 的 template / templates 字段
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">
                    可选模版来自已选绑定技能：{boundSkillTitles}
                    {skillsWithoutTemplates.length > 0
                      ? `（${skillsWithoutTemplates.join("、")} 暂无模版）`
                      : ""}
                  </p>
                )}
              </label>

            </div>
          </section>

          {/* Step 3: 合同预览与保存 */}
          <aside className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{stepLabel(3)}</p>
            <h2 className="mt-2 text-xl font-semibold">合同预览与保存</h2>

            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 p-4 text-sm">
                <p className="text-xs text-slate-500">摘要信息</p>
                <div className="mt-3 space-y-3">
                  <div>
                    <span className="text-slate-500">场景说明（输入）</span>
                    <p className="mt-1 whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                      {sceneDescription.trim() || "（未填写）"}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-500">结果说明（输出）</span>
                    <p className="mt-1 whitespace-pre-wrap text-slate-800 dark:text-slate-200">
                      {resultDescription.trim() || "（未填写）"}
                    </p>
                  </div>
                </div>
                {remoteStatus ? (
                  <p className="mt-3 text-xs text-emerald-300/80">
                    {selectedScenario?.title} · {scenarioStatusLabel(remoteStatus.status)} · v
                    {remoteStatus.version}
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-slate-600">{selectedScenario?.title}</p>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 p-4 text-sm">
                <p className="text-xs text-slate-500">任务信息</p>
                <div className="mt-3 space-y-4">
                  <div>
                    <span className="text-slate-500">强制绑定技能（可选）</span>
                    {forceBindSkill ? (
                      contractAllowedSkills.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {contractAllowedSkills.map((name) => (
                            <span
                              key={name}
                              title={name}
                              className={`rounded-full border px-2.5 py-1 text-xs ${chipBlueActive}`}
                            >
                              {skillLabel(name, skillDisplayByName.get(name))}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-amber-400/90">已开启但未选择技能</p>
                      )
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">未开启，由智能体按场景自选技能</p>
                    )}
                  </div>
                  <div>
                    <span className="text-slate-500">强制绑定知识库（可选）</span>
                    {forceBindKb ? (
                      kbOrdered.length > 0 ? (
                        <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto text-xs text-slate-700 dark:text-slate-300">
                          {kbOrdered.map((name) => (
                            <li key={name} className="truncate" title={name}>
                              {kbCollectionLabel(name)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-xs text-amber-400/90">已开启但未选择集合</p>
                      )
                    ) : (
                      <p className="mt-1 text-xs text-slate-500">未开启，不限制知识集合</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-950/60 p-4">
                <p className="text-sm font-medium">输出物标签</p>
                {selectedTemplateMeta && decodedTemplate ? (
                  <p className="mt-1 truncate text-xs text-slate-500" title={selectedTemplateMeta.label}>
                    来自绑定技能 {skillLabel(decodedTemplate.skillName, skillDisplayByName.get(decodedTemplate.skillName))}
                    （{decodedTemplate.skillName}）· 模版：{selectedTemplateMeta.label}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">请在左侧从已选绑定技能中选择输出模版</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {outputTags.length > 0 ? (
                    outputTags.map((tag) => (
                      <span
                        key={tag}
                        className={`rounded-full border px-3 py-1 text-xs ${chipBlueActive}`}
                      >
                        {tag}
                      </span>
                    ))
                  ) : selectedTemplateMeta ? (
                    <span className="text-xs text-slate-500">该模版未解析到标签或章节结构</span>
                  ) : null}
                </div>
              </div>

              <button
                type="button"
                onClick={runServerPreview}
                disabled={previewBusy}
                className="w-full rounded-2xl border border-slate-300 dark:border-slate-600 bg-slate-200/40 dark:bg-slate-800/40 py-3 text-sm hover:bg-slate-800 disabled:opacity-50"
              >
                {previewBusy ? "生成中…" : "编排合同预览"}
              </button>
              {previewText ? (
                <pre className="max-h-48 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/80 p-3 text-xs text-slate-700 dark:text-slate-300">
                  {previewText}
                </pre>
              ) : null}

              <button
                type="button"
                onClick={saveScenarioDraft}
                disabled={saveBusy || publishBusy}
                className={`w-full rounded-2xl border py-3 text-sm disabled:opacity-50 ${btnEmeraldAction}`}
              >
                {saveBusy ? "保存中…" : "场景保存"}
              </button>
              <button
                type="button"
                onClick={() => void publishScenario()}
                disabled={saveBusy || publishBusy}
                className={`w-full rounded-2xl border py-3 text-sm disabled:opacity-50 ${btnAmberAction}`}
              >
                {publishBusy ? "发布中…" : "发布场景"}
              </button>
              {saveMessage ? (
                <p
                  className={`text-center text-xs ${
                    saveMessage.includes("失败") ? "text-red-600 dark:text-red-400" : accentEmeraldSoft
                  }`}
                >
                  {saveMessage}
                </p>
              ) : null}
              {returnProjectId ? (
                <p className="text-center text-xs text-slate-500">
                  <Link href={`/projects/${returnProjectId}`} className={`${accentLink} hover:underline`}>
                    返回项目绑定场景 →
                  </Link>
                </p>
              ) : null}
            </div>
          </aside>
        </div>

        {loading ? (
          <p className="mt-6 text-center text-sm text-slate-600">加载知识库与技能元数据…</p>
        ) : null}
      </div>

      {addOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !addBusy && setAddOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">新增场景</h3>
            <div className="mt-4 space-y-3 text-sm">
              <input
                value={newScenarioName}
                onChange={(e) => setNewScenarioName(e.target.value)}
                placeholder="场景名称"
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-3 py-2"
              />
              <input
                value={newScenarioCode}
                onChange={(e) => setNewScenarioCode(e.target.value)}
                placeholder="场景编码"
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-3 py-2 font-mono text-xs"
              />
              <textarea
                value={newScenarioDesc}
                onChange={(e) => setNewScenarioDesc(e.target.value)}
                placeholder="描述（可选）"
                rows={2}
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950/70 px-3 py-2"
              />
            </div>
            {addError ? <p className="mt-2 text-xs text-red-400">{addError}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setAddOpen(false)} className="rounded-xl border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm">
                取消
              </button>
              <button
                type="button"
                disabled={addBusy}
                onClick={() => void submitNewScenario()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm disabled:opacity-50"
              >
                {addBusy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
