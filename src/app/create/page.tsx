"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiFetch, readJson } from "@/lib/api";
import type { TaskExecuteOverrides } from "@/lib/chat-context";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { LOCAL_SCENARIO_IDS, SCENARIOS, type Scenario } from "@/lib/scenario-presets";

type OutputTemplateRow = {
  id: string;
  name: string;
  category: string | null;
  format: string | null;
  version: string;
  status: string | null;
};

type ScenarioApiRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
};

/** GET /scenarios/:id 与保存/回填对齐的字段子集 */
type ScenarioDetail = {
  id: string;
  goal: string | null;
  description: string | null;
  preset_instructions: string | null;
  opening_hint: string | null;
  knowledge_policy: Record<string, unknown>;
  skills_policy: Record<string, unknown>;
  output_policy: Record<string, unknown>;
};

function parseOpeningHint(h: string | null | undefined): { deliverable: string; audience: string } {
  if (!h?.trim()) return { deliverable: "", audience: "" };
  const dMatch = h.match(/请输出：([^；]*)/);
  const aMatch = h.match(/受众：(.+)/);
  return {
    deliverable: (dMatch?.[1] ?? "").trim(),
    audience: (aMatch?.[1] ?? "").trim(),
  };
}

function parseAudienceDeliverableFromPreset(preset: string): { audience: string; deliverable: string } {
  let audience = "";
  let deliverable = "";
  for (const raw of preset.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("目标受众：")) audience = line.slice("目标受众：".length).trim();
    if (line.startsWith("期望输出：")) deliverable = line.slice("期望输出：".length).trim();
  }
  return { audience, deliverable };
}

function scenarioFromRemoteRow(row: ScenarioApiRow): Scenario {
  return {
    id: row.id,
    title: row.name,
    summary: row.description ?? "服务端场景，可在右侧完善任务与策略后保存。",
    goal: "请在「任务目标」中描述本场景要达成的结果。",
    recommendedTemplate: "自定义",
    recommendedKnowledgeMode: "按右侧编排中的知识策略",
    recommendedSections: ["背景", "方案", "总结"],
    systemContext:
      row.description?.trim() ||
      `你协助完成「${row.name}」相关产出：回答专业、结构清晰，并遵守右侧编排中的策略与输出模版约束。`,
  };
}

const DEFAULT_SCENARIO_ID = SCENARIOS[0]?.id ?? "general";

export default function CreatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
          加载场景编排...
        </div>
      }
    >
      <CreatePageInner />
    </Suspense>
  );
}

function CreatePageInner() {
  const [collections, setCollections] = useState<string[]>([]);
  const [skillsList, setSkillsList] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenarioId, setSelectedScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [selectedKbKeys, setSelectedKbKeys] = useState<string[]>([]);
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [outputTemplates, setOutputTemplates] = useState<OutputTemplateRow[]>([]);
  const [selectedOutputTemplateId, setSelectedOutputTemplateId] = useState("");
  const [goal, setGoal] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [audience, setAudience] = useState("");
  const [brief, setBrief] = useState("");
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(false);
  const [remoteList, setRemoteList] = useState<ScenarioApiRow[]>([]);
  const [previewText, setPreviewText] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [newScenarioName, setNewScenarioName] = useState("");
  const [newScenarioCode, setNewScenarioCode] = useState("");
  const [newScenarioDesc, setNewScenarioDesc] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const outputTemplatesRef = useRef<OutputTemplateRow[]>([]);
  outputTemplatesRef.current = outputTemplates;

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiGet<{ collections: string[] }>("/kb/collections"),
      apiGet<{ skills: string[] }>("/ws/skills"),
      apiGet<OutputTemplateRow[]>("/templates/"),
    ]).then(([collectionsRes, skillsRes, templatesRes]) => {
      if (cancelled) return;
      const nextCollections =
        collectionsRes.status === "fulfilled" ? collectionsRes.value.collections : [];
      const nextSkills = skillsRes.status === "fulfilled" ? skillsRes.value.skills : [];
      const nextTemplates =
        templatesRes.status === "fulfilled" ? templatesRes.value : [];
      setCollections(nextCollections);
      setSkillsList(nextSkills);
      setOutputTemplates(nextTemplates);
      if (nextCollections.length > 0) {
        setSelectedKbKeys((current) => (current.length > 0 ? current : [nextCollections[0]]));
      }
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

  /** 切换场景时从服务端拉取配置：新场景可填、已保存场景可改 */
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const cols = collections;
    const skills = skillsList;
    const tpls = outputTemplatesRef.current;
    const sid = selectedScenarioId;

    (async () => {
      try {
        setSaveMessage("");
        const row = await apiGet<ScenarioDetail>(`/scenarios/${sid}`);
        if (cancelled) return;

        const localCard = SCENARIOS.find((s) => s.id === sid);
        setGoal(((row.goal ?? "").trim() || localCard?.goal) ?? "");

        const preset = (row.preset_instructions ?? "").trim();
        const fromPreset = parseAudienceDeliverableFromPreset(preset);
        const fromOpen = parseOpeningHint(row.opening_hint);
        setDeliverable(fromPreset.deliverable || fromOpen.deliverable);
        setAudience(fromPreset.audience || fromOpen.audience);
        setBrief(preset || (row.description ?? "").trim());

        const kp = row.knowledge_policy ?? {};
        const rawCols = Array.isArray(kp.collections) ? (kp.collections as string[]) : [];
        const modeK = typeof kp.mode === "string" ? kp.mode : "restricted";
        const intersect = rawCols.filter((c) => cols.includes(c));
        const knowledgeOn =
          intersect.length > 0 ||
          rawCols.length > 0 ||
          (modeK !== "off" && modeK !== "none" && modeK !== "disabled");
        setIncludeKnowledge(knowledgeOn);
        if (intersect.length > 0) setSelectedKbKeys(intersect);
        else if (rawCols.length > 0) setSelectedKbKeys(rawCols);
        else if (knowledgeOn && cols[0]) setSelectedKbKeys([cols[0]]);
        else setSelectedKbKeys([]);

        const sp = row.skills_policy ?? {};
        const allowed = Array.isArray(sp.allowed) ? (sp.allowed as string[]) : [];
        const mode = typeof sp.mode === "string" ? sp.mode : "";
        const skillsOn = mode === "allowed_list" || allowed.length > 0;
        setIncludeSkills(skillsOn);
        const picked = allowed.filter((n) => skills.includes(n));
        if (picked.length > 0) setSelectedSkillKeys(picked);
        else if (skillsOn && skills.length > 0) setSelectedSkillKeys([...skills]);
        else setSelectedSkillKeys([]);

        const op = row.output_policy ?? {};
        const tid = typeof op.template_id === "string" ? op.template_id : "";
        if (tid && tpls.some((t) => t.id === tid)) setSelectedOutputTemplateId(tid);
        else setSelectedOutputTemplateId("");
      } catch {
        if (cancelled) return;
        const local = SCENARIOS.find((s) => s.id === sid);
        setGoal(local?.goal ?? "");
        setDeliverable("");
        setAudience("");
        setBrief("");
        setIncludeKnowledge(true);
        setSelectedKbKeys(cols[0] ? [cols[0]] : []);
        setIncludeSkills(false);
        setSelectedSkillKeys([]);
        setSelectedOutputTemplateId("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedScenarioId, loading, collections, skillsList]);

  useEffect(() => {
    if (outputTemplates.length === 0) return;
    setSelectedOutputTemplateId((prev) =>
      prev && outputTemplates.some((t) => t.id === prev) ? prev : "",
    );
  }, [outputTemplates]);

  async function runServerPreview() {
    if (!selectedScenarioId) return;
    setPreviewBusy(true);
    try {
      const overrides: TaskExecuteOverrides | undefined = selectedOutputTemplateId
        ? { output: { template_id: selectedOutputTemplateId } }
        : undefined;
      const res = await apiFetch(`/scenarios/${selectedScenarioId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: null,
          user_message: "（编排预览）",
          ...(overrides ? { overrides } : {}),
        }),
      });
      const data = await readJson<unknown>(res);
      setPreviewText(JSON.stringify(data, null, 2));
      console.info("[create] 编排预览", {
        scenario_id: selectedScenarioId,
        template_id: selectedOutputTemplateId || null,
      });
    } catch (e) {
      setPreviewText(e instanceof Error ? e.message : "预览失败");
    } finally {
      setPreviewBusy(false);
    }
  }

  const extraRemoteScenarios = useMemo(
    () => remoteList.filter((r) => !LOCAL_SCENARIO_IDS.has(r.id)),
    [remoteList],
  );

  const selectedScenario = useMemo(() => {
    const local = SCENARIOS.find((s) => s.id === selectedScenarioId);
    if (local) return local;
    const row = remoteList.find((r) => r.id === selectedScenarioId);
    if (row) return scenarioFromRemoteRow(row);
    return SCENARIOS[0];
  }, [selectedScenarioId, remoteList]);

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
      const knowledge_policy = {
        mode: "restricted",
        collections: [] as string[],
        project_bound: false,
        top_k: 5,
        fallback_policy: "cache_allowed",
      };
      const skills_policy = {
        mode: "agent_select",
        allowed: [] as string[],
        preferred: [] as string[],
        forbidden: [] as string[],
        allow_agent_free_choice: true,
      };
      const output_policy = {
        template_id: null,
        format: "markdown",
        must_follow_template: false,
        required_sections: [] as string[],
        validation_rules: { must_have_headings: true, must_cite_sources: false },
      };
      const res = await apiFetch("/scenarios/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          name,
          description: newScenarioDesc.trim() || null,
          goal: "待补充：请在编排页填写任务目标后保存。",
          conversation_mode: "task_oriented",
          domain: {},
          knowledge_policy,
          skills_policy,
          output_policy,
          preset_instructions: null,
          opening_hint: null,
        }),
      });
      const created = await readJson<{ id: string; code: string }>(res);
      console.info("[create] 新建场景", { id: created.id, code: created.code });
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

  const kbOrdered = useMemo(
    () => collections.filter((c) => selectedKbKeys.includes(c)),
    [collections, selectedKbKeys],
  );

  const skillOrdered = useMemo(
    () => skillsList.filter((s) => selectedSkillKeys.includes(s)),
    [skillsList, selectedSkillKeys],
  );

  useEffect(() => {
    if (!includeSkills || skillsList.length === 0) return;
    setSelectedSkillKeys((prev) => (prev.length > 0 ? prev : [...skillsList]));
  }, [includeSkills, skillsList]);

  function toggleKb(name: string) {
    if (!includeKnowledge) return;
    setSelectedKbKeys((prev) => {
      if (prev.includes(name)) {
        if (prev.length <= 1) return prev;
        return prev.filter((x) => x !== name);
      }
      return [...prev, name];
    });
  }

  function toggleSkill(name: string) {
    if (!includeSkills) return;
    setSelectedSkillKeys((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
    );
  }

  const outputTemplateSummary = useMemo(() => {
    if (!selectedOutputTemplateId) return "场景默认";
    const row = outputTemplates.find((t) => t.id === selectedOutputTemplateId);
    if (!row) return selectedOutputTemplateId;
    const bits = [row.name, row.category, row.format].filter(Boolean);
    return bits.join(" · ");
  }, [outputTemplates, selectedOutputTemplateId]);

  async function saveScenarioDraft() {
    if (!selectedScenario) return;
    setSaveBusy(true);
    setSaveMessage("");
    try {
      const presetInstructions = [
        `【编排保存】场景：${selectedScenario.title}`,
        goal.trim() ? `任务目标：${goal.trim()}` : `任务目标：${selectedScenario.goal}`,
        deliverable.trim() ? `期望输出：${deliverable.trim()}` : null,
        audience.trim() ? `目标受众：${audience.trim()}` : null,
        brief.trim() ? `补充背景：\n${brief.trim()}` : null,
        `建议章节：${selectedScenario.recommendedSections.join("、")}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      const openingHint = [
        `请输出：${deliverable.trim() || selectedScenario.recommendedTemplate}`,
        audience.trim() ? `受众：${audience.trim()}` : null,
      ]
        .filter(Boolean)
        .join("；");

      const knowledge_policy = {
        mode: "restricted",
        collections: includeKnowledge ? kbOrdered : [],
        project_bound: false,
        top_k: 5,
        fallback_policy: "cache_allowed",
      };

      const skills_policy = {
        mode: includeSkills ? "allowed_list" : "manual_only",
        allowed: includeSkills ? skillOrdered : [],
        preferred: [] as string[],
        forbidden: [] as string[],
        allow_agent_free_choice: includeSkills && skillOrdered.length === 0,
      };

      const output_policy = {
        template_id: selectedOutputTemplateId || null,
        format: "markdown",
        must_follow_template: false,
        required_sections: selectedScenario.recommendedSections,
        validation_rules: {
          must_have_headings: true,
          must_cite_sources: includeKnowledge,
        },
      };

      const updateBody = {
        goal: goal.trim() || selectedScenario.goal,
        description: brief.trim() || selectedScenario.summary,
        preset_instructions: presetInstructions,
        opening_hint: openingHint,
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
            description: selectedScenario.summary,
            goal: updateBody.goal,
            conversation_mode: "task_oriented",
            domain: {},
            knowledge_policy,
            skills_policy,
            output_policy,
            preset_instructions: presetInstructions,
            opening_hint: openingHint,
          }),
        });
      }

      const saved = await readJson<{ id?: string; code?: string }>(res);
      console.info("[create] 场景保存成功", {
        scenario_id: selectedScenario.id,
        saved_id: saved.id,
        saved_code: saved.code,
        createdNew,
      });
      setSaveMessage(
        createdNew
          ? `已新建场景「${saved.code ?? saved.id ?? ""}」并写入编排`
          : "当前场景编排已保存到服务端",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存失败";
      setSaveMessage(msg);
      console.warn("[create] 场景保存失败", msg);
    } finally {
      setSaveBusy(false);
      apiGet<ScenarioApiRow[]>("/scenarios/")
        .then(setRemoteList)
        .catch(() => {});
    }
  }

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
            场景编排
          </div>
          <h1 className="mt-4 text-3xl font-bold sm:text-4xl">场景编排</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
            定义技能、知识范围与输出合同。在左侧选择场景，配置任务与策略，保存编排并同步至服务端。
          </p>
        </div>

        <div className="pb-16">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 1</p>
                  <h3 className="mt-2 text-xl font-semibold">场景列表</h3>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <button
                    type="button"
                    onClick={openAddScenarioModal}
                    className="rounded-xl border border-slate-600 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700"
                  >
                    增加
                  </button>
                  <p className="max-w-[11rem] text-right text-xs leading-snug text-slate-500 sm:max-w-none sm:text-sm">
                    本地 {SCENARIOS.length} 个预设 · 服务端已同步 {remoteList.length} 条场景
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                {SCENARIOS.map((scenario) => {
                  const active = scenario.id === selectedScenarioId;
                  const remote = remoteById.get(scenario.id);
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      onClick={() => setSelectedScenarioId(scenario.id)}
                      className={`rounded-2xl border p-5 text-left transition ${
                        active
                          ? "border-blue-500 bg-blue-500/10 shadow-lg shadow-blue-950/20"
                          : "border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-base font-semibold text-white">{scenario.title}</h4>
                          <p className="mt-2 text-sm leading-relaxed text-slate-400">
                            {scenario.summary}
                          </p>
                        </div>
                        <span
                          className={`mt-1 h-2.5 w-2.5 rounded-full ${
                            active ? "bg-blue-400" : "bg-slate-600"
                          }`}
                          aria-hidden
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
                          {scenario.recommendedTemplate}
                        </span>
                        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-400">
                          {scenario.recommendedKnowledgeMode}
                        </span>
                        {remote && (
                          <span className="rounded-full border border-emerald-700/50 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
                            {remote.status} · v{remote.version}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {extraRemoteScenarios.map((row) => {
                  const active = row.id === selectedScenarioId;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setSelectedScenarioId(row.id)}
                      className={`rounded-2xl border p-5 text-left transition ${
                        active
                          ? "border-violet-500 bg-violet-500/10 shadow-lg shadow-violet-950/20"
                          : "border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-base font-semibold text-white">{row.name}</h4>
                          <p className="mt-2 text-sm leading-relaxed text-slate-400">
                            {row.description ?? "（无描述）"}
                          </p>
                        </div>
                        <span
                          className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                            active ? "bg-violet-400" : "bg-slate-600"
                          }`}
                          aria-hidden
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="rounded-full border border-violet-700/40 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-200">
                          服务端
                        </span>
                        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
                          {row.code}
                        </span>
                        <span className="rounded-full border border-emerald-700/50 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
                          {row.status} · v{row.version}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="min-w-0">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 2</p>
                <h3 className="mt-2 text-xl font-semibold">场景配置</h3>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-500">
                  为新场景填写编排；切换左侧已保存场景后将自动载入服务端配置，可修改后再在第三步保存。
                </p>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-1">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">任务目标</span>
                  <input
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={selectedScenario?.goal}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">期望输出</span>
                  <input
                    value={deliverable}
                    onChange={(e) => setDeliverable(e.target.value)}
                    placeholder={selectedScenario?.recommendedTemplate}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">目标受众</span>
                  <input
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="例如：客户技术负责人、项目评审会、市场团队"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 md:col-span-2 xl:col-span-1">
                  <p className="text-sm font-medium text-white">输出结果</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    基于输出模版：选择后将作为编排输出约束参与预览与工坊执行（未选则跟随场景默认）。
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">当前</span>
                    {selectedOutputTemplateId ? (
                      <span
                        className="max-w-full truncate rounded-full border border-blue-500/70 bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-100"
                        title={outputTemplateSummary}
                      >
                        {outputTemplateSummary}
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-600 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-400">
                        场景默认
                      </span>
                    )}
                  </div>
                  <label className="mt-3 block space-y-2 text-sm">
                    <span className="text-slate-300">输出模版</span>
                    <select
                      value={selectedOutputTemplateId}
                      onChange={(e) => setSelectedOutputTemplateId(e.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500"
                    >
                      <option value="">不指定模版（场景默认）</option>
                      {outputTemplates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.category ? ` · ${t.category}` : ""}
                          {t.format ? ` · ${t.format}` : ""}
                          {t.version ? ` · v${t.version}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {outputTemplates.length === 0 ? (
                    <p className="mt-2 text-xs text-amber-400/90">
                      当前无已登记模版，可在输出模版管理或种子数据中创建后再选。
                    </p>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 md:col-span-2 xl:col-span-1">
                  <p className="text-sm font-medium text-white">策略开关</p>
                  <div className="mt-4 space-y-3 text-sm">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-slate-300">启用知识策略</span>
                      <input
                        type="checkbox"
                        checked={includeKnowledge}
                        onChange={(e) => setIncludeKnowledge(e.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-slate-300">携带技能策略</span>
                      <input
                        type="checkbox"
                        checked={includeSkills}
                        onChange={(e) => setIncludeSkills(e.target.checked)}
                      />
                    </label>
                  </div>
                </div>

                <div className="space-y-2 text-sm md:col-span-2 xl:col-span-1">
                  <span className="text-slate-300">知识库（可多选）</span>
                  <div
                    className={`max-h-40 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 ${
                      !includeKnowledge || collections.length === 0 ? "opacity-50" : ""
                    }`}
                  >
                    {collections.length === 0 ? (
                      <p className="py-2 text-xs text-slate-500">暂无知识集合，请先在知识侧同步</p>
                    ) : (
                      <ul className="space-y-2">
                        {collections.map((name) => (
                          <li key={name}>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                              <input
                                type="checkbox"
                                checked={selectedKbKeys.includes(name)}
                                disabled={!includeKnowledge}
                                onChange={() => toggleKb(name)}
                                className="rounded border-slate-600"
                              />
                              <span className="truncate">{name}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">检索上下文默认使用列表中第一项作为主集合</p>
                </div>

                <div className="space-y-2 text-sm md:col-span-2 xl:col-span-1">
                  <span className="text-slate-300">技能（可多选）</span>
                  <div
                    className={`max-h-40 min-h-[3rem] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-3 ${
                      !includeSkills || skillsList.length === 0 ? "opacity-50" : ""
                    }`}
                  >
                    {skillsList.length === 0 ? (
                      <p className="py-1 text-xs text-slate-500">暂无工坊技能，请先在技能市场安装</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {skillsList.map((name) => {
                          const active = selectedSkillKeys.includes(name);
                          return (
                            <button
                              key={name}
                              type="button"
                              disabled={!includeSkills}
                              onClick={() => toggleSkill(name)}
                              title={name}
                              className={`max-w-full truncate rounded-full border px-3 py-1.5 text-left font-mono text-xs transition ${
                                active
                                  ? "border-blue-500/70 bg-blue-500/15 text-blue-100"
                                  : "border-slate-600 bg-slate-900/40 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                              } disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-600`}
                            >
                              {name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    先开启「携带技能策略」再点选标签；未选时进入对话将按工坊全量技能生效
                  </p>
                </div>
              </div>

              <label className="mt-4 block space-y-2 text-sm">
                <span className="text-slate-300">补充背景</span>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={5}
                  placeholder="补充业务背景、现有材料、禁止事项或必须覆盖的信息"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                />
              </label>
            </div>
          </div>

          <aside className="min-w-0">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 3</p>
                <h3 className="mt-2 text-xl font-semibold">合同预览与保存</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  汇总当前所选场景与第二步编排，生成 JSON 预览，并将配置写入服务端场景。
                </p>
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">合同摘要</p>
                  <p className="mt-2 text-base font-semibold text-white">{selectedScenario?.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    {selectedScenario?.summary}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">任务目标</span>
                    <span className="text-right text-slate-200">
                      {goal.trim() || selectedScenario?.goal}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">期望输出</span>
                    <span className="text-right text-slate-200">
                      {deliverable.trim() || selectedScenario?.recommendedTemplate}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">输出模版</span>
                    <span className="max-w-[min(16rem,55%)] text-right text-slate-200">
                      {outputTemplateSummary}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">知识库</span>
                    <span className="text-right text-slate-200">
                      {includeKnowledge
                        ? kbOrdered.length > 0
                          ? kbOrdered.join("、")
                          : "未选"
                        : "关闭"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">技能</span>
                    <span className="text-right text-slate-200">
                      {includeSkills
                        ? skillOrdered.length > 0
                          ? `${skillOrdered.length} 项：${skillOrdered.slice(0, 4).join("、")}${
                              skillOrdered.length > 4 ? "…" : ""
                            }`
                          : "全量（进入对话后）"
                        : "关闭"}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-medium text-white">建议章节</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedScenario?.recommendedSections.map((section) => (
                      <span
                        key={section}
                        className="rounded-full border border-blue-500/70 bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-100"
                      >
                        {section}
                      </span>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={runServerPreview}
                  disabled={previewBusy}
                  className="w-full rounded-2xl border border-slate-600 bg-slate-800/40 px-5 py-3 text-sm font-medium text-slate-100 transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {previewBusy ? "生成预览中…" : "服务端编排预览（JSON）"}
                </button>
                {previewText ? (
                  <pre className="max-h-64 overflow-auto rounded-2xl border border-slate-800 bg-slate-950/80 p-3 text-xs text-slate-300">
                    {previewText}
                  </pre>
                ) : null}

                <button
                  type="button"
                  onClick={saveScenarioDraft}
                  disabled={saveBusy}
                  className="w-full rounded-2xl border border-emerald-600/50 bg-emerald-500/15 px-5 py-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  {saveBusy ? "保存中…" : "场景保存"}
                </button>
                {saveMessage ? (
                  <p
                    className={`text-center text-xs ${
                      saveMessage.includes("失败") || saveMessage.startsWith("HTTP")
                        ? "text-red-400"
                        : "text-emerald-300/90"
                    }`}
                  >
                    {saveMessage}
                  </p>
                ) : null}
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-10 text-center text-sm text-slate-600">
          {loading ? "正在加载知识集合与技能..." : null}
        </div>
      </div>

      {addOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onClick={() => !addBusy && setAddOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-scenario-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="add-scenario-title" className="text-lg font-semibold text-white">
              新增场景
            </h4>
            <p className="mt-1 text-xs text-slate-500">将创建一条服务端场景草稿，可在右侧继续编排后点「场景保存」。</p>
            <div className="mt-4 space-y-3 text-sm">
              <label className="block space-y-1.5">
                <span className="text-slate-300">场景名称</span>
                <input
                  value={newScenarioName}
                  onChange={(e) => setNewScenarioName(e.target.value)}
                  placeholder="例如：客户汇报专用"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-slate-300">场景编码</span>
                <input
                  value={newScenarioCode}
                  onChange={(e) => setNewScenarioCode(e.target.value)}
                  placeholder="英文小写、数字、连字符"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 font-mono text-xs text-white outline-none focus:border-blue-500"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-slate-300">描述（可选）</span>
                <textarea
                  value={newScenarioDesc}
                  onChange={(e) => setNewScenarioDesc(e.target.value)}
                  rows={3}
                  placeholder="简要说明使用场景"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-white outline-none focus:border-blue-500"
                />
              </label>
            </div>
            {addError ? <p className="mt-3 text-xs text-red-400">{addError}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={addBusy}
                onClick={() => setAddOpen(false)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={addBusy}
                onClick={() => void submitNewScenario()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {addBusy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </main>
  );
}
