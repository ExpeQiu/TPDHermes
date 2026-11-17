"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import { ProjectFilesRail } from "@/components/project-files-rail";
import { apiFetch, apiGet, apiPost } from "@/lib/api";
import { decodeProjectFileSelectValue, type ProjectRecord } from "@/lib/chat-context";
import { fetchProjectFilesUnified, type ProjectFileItem } from "@/lib/co-create-api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { blockedProductIds, exportConflicts, promotionProductLabel, PROMOTION_PRODUCTS, RETIRED_PROMOTION_PRODUCTS, structuredHighAccuracyRows, type StructuredAccuracyRow } from "@/lib/promotion-package";

interface Evidence {
  file_id?: string;
  locator?: string;
  excerpt?: string;
  url?: string;
  doc_id?: string;
}

interface FieldRow {
  key: string;
  label: string;
  status: string;
  reason?: string;
  attention?: string;
  blocks?: string[];
  evidence?: Evidence[];
}

interface Candidate {
  id: string;
  origin: string;
  claim: string;
  value: string;
  needs_confirm?: boolean;
  source?: { url?: string; doc_id?: string; locator?: string };
  adopted?: boolean;
}

interface Fact {
  id: string;
  claim: string;
  value: string;
  unit?: string;
  conditions?: string;
  visibility?: string;
  source_type?: string;
  source_ref?: string;
  candidate_id?: string;
}

interface VersionRow {
  output_id: string;
  version: string;
  status: string;
  fact_ids: string[];
  content?: string;
  fingerprint?: string;
  brief_version?: number;
}

interface PackageDetail {
  id: string;
  revision: number;
  status: string;
  role: string;
  brief_version: number;
  facts_version: number;
  file_refs: Array<{ file_id: string; kind?: string }>;
  snapshot: Array<{ file_id: string; title?: string; parse_status?: string; digest?: string; kind?: string }>;
  assessment: {
    fields?: FieldRow[];
    candidates?: Candidate[];
    blocked_products?: string[];
    fill?: { project?: number; kb?: number; web?: number };
  };
  brief: {
    goal?: string;
    audience?: string;
    summary?: string;
    wiki?: {
      title?: string;
      summary?: string;
      sections?: Array<{ heading: string; body: string }>;
      claims?: Array<{ id: string; statement: string; conditions?: string; source?: string; usage?: string }>;
    };
  };
  facts: Fact[];
  products_state: Record<string, { head_output_id: string; status: string; versions: VersionRow[] }>;
  steps: Array<{ step_key: string; status: string; error_type?: string; input_version?: string }>;
  actions: {
    assess?: boolean;
    confirm?: boolean;
    generate?: boolean;
    approve?: boolean;
    products?: Record<string, { revise?: boolean; submit?: boolean; reject?: boolean; approve?: boolean }>;
  };
}

const STAGES = [
  { id: "materials", title: "资料", hint: "先识别项目资料，再评估质量、补充缺口，最后压缩成可引用事实。" },
  { id: "outputs", title: "出品与审核", hint: "勾选出品后，选一篇用单一驱动生成，选多篇用批量驱动生成。改稿先保存，再提交审核。" },
  { id: "export", title: "导出", hint: "勾选已生成的文件，保存到项目文件夹；已批准的文件可下载 ZIP。" },
];

const RETIRED_PRODUCT_IDS = new Set<string>(RETIRED_PROMOTION_PRODUCTS);

function outputRows(detail: PackageDetail) {
  const state = detail.products_state || {};
  const ids = [
    ...PROMOTION_PRODUCTS.map((item) => item.id),
    ...Object.keys(state).filter((id) => !PROMOTION_PRODUCTS.some((item) => item.id === id) && !RETIRED_PRODUCT_IDS.has(id)),
  ];
  return ids.map((product) => ({
    product,
    state: state[product] || { head_output_id: "", status: "idle", versions: [] as VersionRow[] },
  }));
}

const WORKSPACE = "min-h-0 flex-1 overflow-y-auto bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white";
const SURFACE = "rounded-3xl border border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/50";
const ROW = "rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40";
const BTN = "rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40";
const BTN_LINE = "rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";
const FIELD = "rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-950";

function stepCard(active: boolean): string {
  return active
    ? "cursor-pointer rounded-3xl border border-blue-500 bg-blue-50/80 p-5 ring-1 ring-blue-500 dark:bg-blue-950/40"
    : `${SURFACE} cursor-pointer p-5 transition hover:border-slate-300`;
}

function openStep(body: PackageDetail): number {
  const fields = body.assessment.fields ?? [];
  const assessedNow = fields.length > 0;
  const gaps = fields.some((field) => field.status === "missing" || field.status === "conflict");
  if (!assessedNow) return 0;
  if (gaps && body.facts.length === 0) return 2;
  if (body.brief_version || body.facts.length > 0) return 3;
  return 1;
}

const LABELS: Record<string, string> = {
  draft: "草稿",
  pending_review: "待审核",
  rejected: "退回",
  approved: "已批准",
  needs_rereview: "待复审",
  idle: "未生成",
  present: "已找到依据",
  missing: "待补充",
  conflict: "来源冲突",
  unreadable: "无法读取",
  ok: "已读取",
  kb: "知识库",
  web: "联网检索",
  project: "项目资料",
};

export default function PromotionTaskPage() {
  return (
    <Suspense fallback={<p className={WORKSPACE}>正在读取任务…</p>}>
      <PromotionTaskTabs />
    </Suspense>
  );
}

function PromotionTaskTabs() {
  const searchParams = useSearchParams();
  const params = useParams<{ id: string; packageId: string }>();
  const router = useRouter();
  const projectId = String(params.id || "");
  const packageId = String(params.packageId || "");
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFileItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesRefreshKey, setProjectFilesRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [saveHint, setSaveHint] = useState("");
  const [stageIndex, setStageIndex] = useState<number | null>(null);
  function setStage(index: number) {
    setStageIndex(index);
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === STAGES[index].id) return;
    url.searchParams.set("tab", STAGES[index].id);
    window.history.pushState(null, "", url);
  }
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState("对外介绍技术价值");
  const [audience, setAudience] = useState("行业媒体");
  const [adopted, setAdopted] = useState<string[]>([]);
  const [manualFacts, setManualFacts] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [exportSelection, setExportSelection] = useState<string[] | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [detailStep, setDetailStep] = useState<number | null>(null);
  const [accurateRows, setAccurateRows] = useState<StructuredAccuracyRow[]>([]);
  const [openMaterial, setOpenMaterial] = useState<{ id: string; kind: string; title: string } | null>(null);
  const [materialDetail, setMaterialDetail] = useState<{ title?: string; content?: string; status?: string; file_type?: string; version?: string | null } | null>(null);

  const load = useCallback(async () => {
    const body = await apiGet<PackageDetail>(`/projects/${projectId}/promotion-packages/${packageId}`);
    setDetail(body);
    setAdopted(body.facts.flatMap((fact) => fact.candidate_id ? [fact.candidate_id] : []));
    if (body.brief?.goal) setGoal(body.brief.goal);
    if (body.brief?.audience) setAudience(body.brief.audience);
    setDetailStep((current) => {
      if (current !== null) return current;
      const step = openStep(body);
      console.info("[promotion] open-step", { packageId, step, facts: body.facts.length });
      return step;
    });
  }, [packageId, projectId]);

  useEffect(() => {
    if (!projectId || !packageId) return;
    void load().catch((err: Error) => setError(err.message));
  }, [load, packageId, projectId]);

  useEffect(() => {
    let cancelled = false;
    apiGet<ProjectRecord[]>("/projects/")
      .then((rows) => {
        if (!cancelled) setProjects(Array.isArray(rows) ? rows : []);
      })
      .catch((err) => {
        console.warn("[promotion] 项目列表加载失败", err);
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setProjectFiles([]);
      setProjectFilesLoading(false);
      return;
    }
    let cancelled = false;
    setProjectFilesLoading(true);
    fetchProjectFilesUnified(projectId)
      .then((files) => {
        if (!cancelled) setProjectFiles(files);
      })
      .catch((err) => {
        console.warn("[promotion] 项目文件加载失败", { projectId, err });
        if (!cancelled) setProjectFiles([]);
      })
      .finally(() => {
        if (!cancelled) setProjectFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projectFilesRefreshKey]);

  useEffect(() => {
    if (!openMaterial) {
      setMaterialDetail(null);
      return;
    }
    const material = openMaterial;
    let cancelled = false;
    void apiGet<{ title?: string; content?: string; status?: string; file_type?: string; version?: string | null }>(
      `/projects/${projectId}/files/${material.id}?kind=${encodeURIComponent(material.kind || "attachment")}`,
    )
      .then((body) => {
        if (!cancelled) setMaterialDetail(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [openMaterial, projectId]);

  const fileBooted = useRef(false);
  useEffect(() => {
    if (detailStep !== 0 || openMaterial || fileBooted.current || !detail) return;
    const ref = detail.file_refs?.[0];
    const file = projectFiles.find((item) => item.id === ref?.file_id) || projectFiles[0];
    const snap = detail.snapshot.find((item) => item.file_id === (file?.id || ref?.file_id));
    const picked = file
      ? { id: file.id, kind: file.kind, title: file.title }
      : ref
        ? { id: ref.file_id, kind: ref.kind || snap?.kind || "output", title: snap?.title || "项目文件" }
        : null;
    if (!picked) return;
    fileBooted.current = true;
    setOpenMaterial(picked);
    console.info("[promotion] open-material", { packageId, fileId: picked.id });
  }, [detail, detailStep, openMaterial, packageId, projectFiles]);

  const sourceKey = (detail?.file_refs?.length
    ? detail.file_refs.map((ref) => `${ref.file_id}:${ref.kind || "output"}`)
    : projectFiles.map((file) => `${file.id}:${file.kind}`)
  ).join("|");

  useEffect(() => {
    if (detailStep !== 3 || !sourceKey) {
      return;
    }
    const refs = sourceKey.split("|").map((item) => {
      const [id, kind] = item.split(":");
      return { id, kind: kind || "output" };
    });
    let cancelled = false;
    void Promise.all(
      refs.map((ref) =>
        apiGet<{ title?: string; content?: string }>(
          `/projects/${projectId}/files/${ref.id}?kind=${encodeURIComponent(ref.kind)}`,
        )
          .then((body) => structuredHighAccuracyRows(body.content || "", body.title || ""))
          .catch(() => [] as StructuredAccuracyRow[]),
      ),
    ).then((groups) => {
      if (cancelled) return;
      const rows = groups.flat();
      console.info("[promotion] structured-facts", { packageId, count: rows.length });
      setAccurateRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [detailStep, packageId, projectId, sourceKey]);

  useEffect(() => {
    if (!detail?.steps.some((step) => step.status === "running")) return;
    const timer = window.setTimeout(() => {
      void load().catch((err: Error) => setError(err.message));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [detail, load]);

  const blocked = useMemo(
    () => blockedProductIds(detail?.assessment.fields ?? []),
    [detail],
  );

  async function run(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await apiPost(path, body);
      if (path.endsWith("/revise")) {
        setDrafts((current) => {
          const next = { ...current };
          for (const [product, state] of Object.entries(detail?.products_state ?? {})) {
            if (state.head_output_id === (body as { output_id: string }).output_id) delete next[product];
          }
          return next;
        });
      }
      if (path.endsWith("/facts")) setManualFacts({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  function factsForConfirm(): Fact[] {
    if (!detail) return [];
    const facts = new Map(detail.facts.map((fact) => [fact.claim, fact]));
    for (const field of detail.assessment.fields ?? []) {
      const evidence = field.evidence?.[0];
      if (field.status !== "present" || !evidence?.excerpt || facts.has(field.key)) continue;
      facts.set(field.key, {
        id: "", claim: field.key, value: evidence.excerpt,
        visibility: "public", source_type: "file", source_ref: evidence.file_id || "",
      });
    }
    for (const candidate of detail.assessment.candidates ?? []) {
      if (!adopted.includes(candidate.id) || facts.get(candidate.claim)?.candidate_id === candidate.id) continue;
      facts.set(candidate.claim, {
        id: facts.get(candidate.claim)?.id ?? "", claim: candidate.claim, value: candidate.value,
        visibility: "public", source_type: candidate.origin, candidate_id: candidate.id,
      });
    }
    for (const [claim, value] of Object.entries(manualFacts)) {
      if (!value.trim()) continue;
      facts.set(claim, {
        id: facts.get(claim)?.id ?? "", claim, value: value.trim(),
        visibility: "public", source_type: "human",
      });
    }
    return [...facts.values()].filter((fact) => !fact.candidate_id || adopted.includes(fact.candidate_id));
  }

  const chosenProducts = exportSelection ?? (detail ? outputRows(detail).map((item) => item.product) : []);
  const saveIds = useMemo(() => {
    if (!detail) return [];
    return Object.entries(detail.products_state || {}).flatMap(([product, state]) => {
      if (RETIRED_PRODUCT_IDS.has(product) || !chosenProducts.includes(product)) return [];
      const head = (state.versions || []).find((item) => item.output_id === state.head_output_id);
      if (!head?.output_id || state.status === "idle") return [];
      return [head.output_id];
    });
  }, [chosenProducts, detail]);
  const downloadIds = useMemo(() => {
    if (!detail) return [];
    return Object.entries(detail.products_state || {}).flatMap(([product, state]) => {
      if (RETIRED_PRODUCT_IDS.has(product) || !chosenProducts.includes(product)) return [];
      const head = (state.versions || []).find((item) => item.output_id === state.head_output_id);
      if (!head || head.status !== "approved") return [];
      return [head.output_id];
    });
  }, [chosenProducts, detail]);
  const exportChoices = useMemo(() => {
    if (!detail) return [];
    return downloadIds.map((outputId) => {
      let status = "draft";
      let stale = false;
      for (const state of Object.values(detail.products_state || {})) {
        const version = (state.versions || []).find((item) => item.output_id === outputId);
        if (!version) continue;
        status = version.status;
        stale = version.status === "needs_rereview";
      }
      return { id: outputId, status, stale };
    });
  }, [detail, downloadIds]);
  const conflicts = exportConflicts(exportChoices);

  async function download() {
    if (conflicts.length > 0) {
      setError(`导出冲突：${conflicts.map((item) => `${item.id} ${item.reason}`).join("；")}`);
      return;
    }
    setError("");
    const response = await apiFetch(`/projects/${projectId}/promotion-packages/${packageId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output_ids: downloadIds }),
    });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "promotion-package.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function saveToProject() {
    if (!saveIds.length) {
      setError("所选出品还没有生成内容");
      return;
    }
    setBusy(true);
    setError("");
    setSaveHint("");
    try {
      const response = await apiFetch(`/projects/${projectId}/promotion-packages/${packageId}/save-to-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output_ids: saveIds }),
      });
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      const body = await response.json() as { saved?: number };
      const count = body.saved ?? saveIds.length;
      setSaveHint(`已保存 ${count} 个文件到项目文件夹`);
      console.info("[promotion] save project", { projectId, packageId, files: count, output_ids: saveIds });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      console.warn("[promotion] save project failed", err);
    } finally {
      setBusy(false);
    }
  }

  function renderProjectFilesRail(autoHide = false) {
    const fileKey = openMaterial ? `${openMaterial.kind || "attachment"}:${openMaterial.id}` : null;
    return (
      <ProjectFilesRail
        scope="promotion"
        autoHide={autoHide}
        projects={projects}
        projectId={projectId}
        fileKey={fileKey}
        files={projectFiles}
        loading={projectFilesLoading}
        onProjectChange={(next) => {
          if (!next || next === projectId) return;
          console.info("[promotion] 文件栏切换项目", { from: projectId, to: next });
          router.push(`/projects/${next}/promotion`);
        }}
        onFileChange={(next) => {
          const decoded = next ? decodeProjectFileSelectValue(next) : null;
          if (!decoded) {
            setOpenMaterial(null);
            return;
          }
          const file = projectFiles.find((item) => item.id === decoded.id && item.kind === decoded.kind);
          setStage(0);
          setDetailStep(0);
          setOpenMaterial({ id: decoded.id, kind: decoded.kind, title: file?.title || "项目文件" });
          console.info("[promotion] 文件栏选择文件", { projectId, file: next });
        }}
        onRefresh={() => setProjectFilesRefreshKey((value) => value + 1)}
      />
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full min-h-0">
        <main className={WORKSPACE}>
          <div className={`${CONTENT_MAX_CLASS} text-sm text-slate-500`} role={error ? "alert" : "status"}>{error ? `读取任务失败：${error}` : "正在读取任务…"}</div>
        </main>
        <div className="hidden h-full min-h-0 lg:flex">{renderProjectFilesRail(true)}</div>
      </div>
    );
  }

  const assessed = (detail.assessment.fields?.length ?? 0) > 0;
  const visibleStates = Object.entries(detail.products_state).filter(([product]) => !RETIRED_PRODUCT_IDS.has(product)).map(([, state]) => state);
  const hasApproved = visibleStates.some((state) =>
    state.versions.some((version) => version.status === "approved"),
  );
  const allApproved = visibleStates.length > 0 && visibleStates.every((state) => state.status === "approved");
  const requestedTab = STAGES.findIndex(({ id }) => id === searchParams.get("tab"));
  const currentStage = stageIndex ?? (requestedTab >= 0 ? requestedTab : !detail.brief_version ? 0 : hasApproved && allApproved ? 2 : 1);
  const fieldLabels = Object.fromEntries((detail.assessment.fields ?? []).map((field) => [field.key, field.label]));

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <details className="group shrink-0 border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>项目文件</span>
          <span className="text-xs text-slate-500 group-open:hidden">展开</span>
          <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
        </summary>
        <div className="h-[42vh] min-h-0 border-t border-slate-200 dark:border-slate-800">
          {renderProjectFilesRail()}
        </div>
      </details>
    <main className={WORKSPACE}>
      <div className={`${CONTENT_MAX_CLASS} space-y-6`}>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">技术推广包</h1>
        </div>
        <Link href={`/projects/${projectId}/promotion`} className="text-sm text-slate-500">
          返回列表
        </Link>
      </div>
      {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-red-600">{error}</p> : null}

      <div role="tablist" aria-label="技术推广包" className="flex gap-4 border-b border-slate-200 dark:border-slate-700">
        {STAGES.map(({ id, title }, index) => (
          <button
            key={id}
            id={`tab-${id}`}
            type="button"
            role="tab"
            aria-selected={currentStage === index}
            aria-controls={`panel-${id}`}
            tabIndex={currentStage === index ? 0 : -1}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm ${currentStage === index ? "border-blue-500 font-semibold text-slate-900 dark:text-white" : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white"}`}
            onClick={() => setStage(index)}
            onKeyDown={(event) => {
              const last = STAGES.length - 1;
              const targets: Record<string, number> = {
                ArrowLeft: (index + last) % STAGES.length,
                ArrowRight: (index + 1) % STAGES.length,
                Home: 0,
                End: last,
              };
              const target = targets[event.key];
              if (target === undefined) return;
              event.preventDefault();
              setStage(target);
              document.getElementById(`tab-${STAGES[target].id}`)?.focus();
            }}
          >
            {title}
          </button>
        ))}
      </div>
      <fieldset disabled={busy} className="min-w-0 disabled:opacity-70">
        <legend className="sr-only">{STAGES[currentStage].title}</legend>
        {busy ? <p role="status" className="mb-3 text-sm">正在处理…</p> : null}
      <div className={currentStage === 0 ? "grid items-start gap-4 lg:grid-cols-3" : ""}>
      <section role="tabpanel" id="panel-materials" aria-labelledby="tab-materials" tabIndex={0} hidden={currentStage !== 0} className="space-y-4">
        <section className={stepCard(detailStep === 0)} onClick={() => setDetailStep(0)}>
          <h2 className="font-medium">1. 识别现有项目信息</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(detail.file_refs?.length
              ? detail.file_refs.map((ref) => {
                  const file = projectFiles.find((item) => item.id === ref.file_id);
                  const snap = detail.snapshot.find((item) => item.file_id === ref.file_id);
                  return {
                    id: ref.file_id,
                    title: file?.title || snap?.title || "项目文件",
                    kind: ref.kind || file?.kind || "",
                    parseStatus: snap?.parse_status,
                  };
                })
              : projectFiles.map((file) => ({
                  id: file.id,
                  title: file.title,
                  kind: file.kind,
                  parseStatus: detail.snapshot.find((item) => item.file_id === file.id)?.parse_status,
                }))
            ).map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  aria-pressed={openMaterial?.id === file.id}
                  className={`w-full rounded-2xl px-3 py-2 text-left transition hover:bg-slate-100 dark:hover:bg-slate-800 ${openMaterial?.id === file.id ? "bg-blue-50 ring-1 ring-blue-500 dark:bg-blue-950" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetailStep(0);
                    setOpenMaterial({ id: file.id, kind: file.kind || "attachment", title: file.title });
                  }}
                >
                  {file.title}
                  {file.kind ? <span className="ml-2 text-xs text-slate-400">{file.kind}</span> : null}
                  {file.parseStatus ? (
                    <span className="ml-2 text-xs text-slate-500">{file.parseStatus === "ok" ? "已读取" : "无法读取"}</span>
                  ) : null}
                </button>
              </li>
            ))}
            {(detail.file_refs?.length ?? 0) === 0 && projectFiles.length === 0 ? (
              <li className="text-slate-500">还没有可识别的项目资料。</li>
            ) : null}
          </ul>
        </section>
        <section className={stepCard(detailStep === 1)} onClick={() => setDetailStep(1)}>
          <h2 className="font-medium">2. 信息质量评估</h2>
          <p className="mt-1 text-sm text-slate-500">判断已识别信息是可用、缺失、冲突，还是无法读取。</p>
          {detail.actions.assess ? (
            <button
              type="button"
              disabled={(detail.file_refs?.length ?? 0) === 0 && projectFiles.length === 0}
              className={`mt-3 ${BTN}`}
              onClick={() =>
                void run(`/projects/${projectId}/promotion-packages/${packageId}/assess`, {
                  expected_revision: detail.revision,
                })
              }
            >
              {assessed ? "重新评估" : "开始评估"}
            </button>
          ) : null}
          <p className="mt-3 text-sm text-slate-500">
            {assessed
              ? `已评估 ${detail.assessment.fields?.length ?? 0} 项，详情在右侧。`
              : (detail.file_refs?.length ?? 0) === 0 && projectFiles.length === 0
                ? "还没有可评估的项目资料。"
                : "评估结果会显示在右侧详情。"}
          </p>
        </section>
        <section id="step-fill" className={stepCard(detailStep === 2)} onClick={() => setDetailStep(2)}>
          <h2 className="font-medium">3. 补充缺少的信息</h2>
          <p className="mt-1 text-sm text-slate-500">只处理评估标出的缺失和冲突，可采纳检索结果或手工补录。</p>
          {detail.actions.assess ? (
            <button
              type="button"
              disabled={!assessed}
              className={`mt-3 ${BTN}`}
              onClick={(event) => {
                event.stopPropagation();
                setDetailStep(2);
                console.info("[promotion] search-and-fill", { packageId, sources: ["project", "kb", "web"] });
                void run(`/projects/${projectId}/promotion-packages/${packageId}/assess`, {
                  expected_revision: detail.revision,
                  fill: true,
                });
              }}
            >
              检索与补充
            </button>
          ) : null}
          <p className="mt-3 text-sm text-slate-500">
            {!assessed
              ? "先完成质量评估，再检索缺口。"
              : (detail.assessment.candidates ?? []).length > 0
                ? `已有 ${detail.assessment.candidates?.length} 条检索结果，在右侧采纳或补录。`
                : "检索结果和补录表在右侧。"}
          </p>
        </section>
        <section className={stepCard(detailStep === 3)} onClick={() => setDetailStep(3)}>
          <h2 className="font-medium">4. 结构化压缩</h2>
          <p className="mt-1 text-sm text-slate-500">按技术页收成定义、机制、指标和应用，只保留可核验的核心事实。</p>
          {detail.actions.confirm ? (
            <button
              type="button"
              disabled={!assessed}
              className={`mt-3 ${BTN}`}
              onClick={(event) => {
                event.stopPropagation();
                setDetailStep(3);
                const facts = factsForConfirm();
                console.info("[promotion] compress-facts", { packageId, factCount: facts.length });
                void run(`/projects/${projectId}/promotion-packages/${packageId}/facts`, {
                  expected_revision: detail.revision,
                  goal,
                  audience,
                  facts,
                  adopted_candidate_ids: adopted,
                });
              }}
            >
              压缩事实
            </button>
          ) : null}
          <p className="mt-3 text-sm text-slate-500">
            {detail.facts.length > 0 ? `已压缩 ${detail.facts.length} 条事实，详情在右侧。` : "目标和事实条目在右侧确认。"}
          </p>
        </section>
      </section>
      {currentStage === 0 ? (
        <aside className={`${SURFACE} sticky top-4 flex max-h-[calc(100vh-8rem)] flex-col overflow-hidden lg:col-span-2`}>
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
            <div className="min-w-0">
              <h2 className="truncate font-medium">
                {detailStep === 0 && openMaterial
                  ? materialDetail?.title || openMaterial.title
                  : ["识别现有项目信息", "信息质量评估", "补充缺少的信息", "结构化压缩"][detailStep ?? -1] || "详情"}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {detailStep === null
                  ? "点击左侧步骤，这里只显示这一步。"
                  : detailStep === 0 && openMaterial
                    ? [openMaterial.kind || "资料", materialDetail?.file_type, materialDetail?.status, materialDetail?.version ? `v${materialDetail.version}` : ""].filter(Boolean).join(" · ")
                    : "当前步骤"}
              </p>
            </div>
            {detailStep === 0 && openMaterial ? (
              <button type="button" className="shrink-0 text-sm text-slate-500" onClick={() => setOpenMaterial(null)}>
                关闭文稿
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4 text-slate-800 dark:text-slate-100">
            {detailStep === null ? <p className="text-sm text-slate-500">点击左侧步骤查看对应详情。</p> : null}
            {detailStep === 0 ? (
              openMaterial ? (
                materialDetail ? (
                  materialDetail.content ? (
                    <ChatMarkdownBody content={materialDetail.content} />
                  ) : (
                    <p className="text-sm text-slate-500">这份资料没有可预览的正文。</p>
                  )
                ) : (
                  <p className="text-sm text-slate-500">正在读取详情…</p>
                )
              ) : (
                <p className="text-sm text-slate-500">点选左侧资料，查看正文。</p>
              )
            ) : null}
            {detailStep === 1 ? (
            <section>
              <h3 className="text-sm font-medium">信息质量评估</h3>
              {assessed ? (
                <div className="mt-3 space-y-2 text-sm">
                  {(detail.assessment.fields ?? []).map((field) => (
                    <div key={field.key} className={ROW}>
                      <p>
                        {field.label} · {LABELS[field.status] || "待核对"}
                        {field.reason ? ` · ${field.reason}` : ""}
                      </p>
                      {(field.evidence ?? []).map((item, index) => (
                        <p key={`${field.key}-${index}`} className="text-xs text-slate-500">
                          {detail.snapshot.find((file) => file.file_id === item.file_id)?.title} {item.locator} {item.excerpt}
                        </p>
                      ))}
                    </div>
                  ))}
                  {blocked.length > 0 ? (
                    <p className="text-sm text-amber-700">质量不足会挡住：{blocked.map((id) => promotionProductLabel(id)).join("、")}</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">完成左侧评估后，各项缺口会列在这里。</p>
              )}
            </section>
            ) : null}
            {detailStep === 2 ? (
            <section>
              <h3 className="text-sm font-medium">补充缺少的信息</h3>
              {assessed ? (
                <p className="mt-2 text-sm text-slate-500">
                  {detail.assessment.fill
                    ? `已检索项目资料 ${detail.assessment.fill.project ?? 0} 条、知识库 ${detail.assessment.fill.kb ?? 0} 条、互联网 ${detail.assessment.fill.web ?? 0} 条。高亮项需要确认或填写。`
                    : "检索会同时查项目资料、知识库和互联网。高亮项需要确认或填写。"}
                </p>
              ) : null}
              {assessed ? (
                <div className="mt-3 space-y-3 text-sm">
                  {(detail.assessment.fields ?? [])
                    .filter((field) => field.status === "missing" || field.status === "conflict")
                    .map((field) => {
                      const hits = (detail.assessment.candidates ?? []).filter((item) => item.claim === field.key);
                      const confirmed = hits.some((item) => adopted.includes(item.id)) || Boolean(manualFacts[field.key]?.trim());
                      const tone = confirmed ? "" : hits.length || field.status === "conflict" || field.attention === "confirm" ? "confirm" : "fill";
                      return (
                        <div
                          key={field.key}
                          className={
                            tone
                              ? "rounded-2xl border border-amber-400 bg-amber-50 p-3 ring-1 ring-amber-300 dark:border-amber-500/70 dark:bg-amber-950/40"
                              : ROW
                          }
                        >
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            {field.label}
                            {tone === "confirm" ? <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-900">待确认</span> : null}
                            {tone === "fill" ? <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs text-amber-900">待填写</span> : null}
                          </p>
                          {field.reason ? <p className="mt-1 text-xs text-slate-500">{field.reason}</p> : null}
                          {hits.map((candidate) => (
                            <label key={candidate.id} className="mt-2 flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={adopted.includes(candidate.id)}
                                onChange={(event) =>
                                  setAdopted((current) =>
                                    event.target.checked ? [...current, candidate.id] : current.filter((item) => item !== candidate.id),
                                  )
                                }
                              />
                              <span>
                                确认{LABELS[candidate.origin] || "检索"}结果 · {candidate.value}
                                <span className="block text-xs text-slate-500">
                                  {[candidate.source?.doc_id, candidate.source?.locator, candidate.source?.url].filter(Boolean).join(" ")}
                                </span>
                              </span>
                            </label>
                          ))}
                          <label className="mt-2 grid gap-1">
                            {tone === "fill" ? "请填写" : "或手工补录"}
                            <input
                              className={tone === "fill" ? `${FIELD} border-amber-400 bg-amber-50 dark:bg-amber-950/40` : FIELD}
                              value={manualFacts[field.key] ?? ""}
                              onChange={(event) => setManualFacts((current) => ({ ...current, [field.key]: event.target.value }))}
                            />
                          </label>
                        </div>
                      );
                    })}
                  {(detail.assessment.fields ?? []).every((field) => field.status !== "missing" && field.status !== "conflict") ? (
                    <p className="text-slate-500">没有需要补充的信息。</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-sm text-slate-500">先完成质量评估，再补充缺口。</p>
              )}
            </section>
            ) : null}
            {detailStep === 3 ? (
            <section>
              <h3 className="text-sm font-medium">结构化压缩</h3>
              <p className="mt-1 text-xs text-slate-500">按技术页保留核心事实。空值和待补充不进入，条件和来源紧挨结论，供下一步出品引用。</p>
              {detail.brief?.wiki?.sections?.length ? (
                <div className="mt-3 space-y-3">
                  {detail.brief.wiki.sections.map((section) => (
                    <div key={section.heading} className={ROW}>
                      <p className="text-sm font-medium">{section.heading}</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{section.body}</p>
                    </div>
                  ))}
                  <div className="space-y-2">
                    {(detail.brief.wiki.claims ?? []).map((claim) => (
                      <div key={claim.id} className={ROW}>
                        <p className="text-sm">{claim.statement}{claim.conditions ? `（${claim.conditions}）` : ""}</p>
                        <p className="text-xs text-slate-500">
                          {[claim.usage === "internal" ? "内部" : "可引用", claim.source].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="mt-3 space-y-2 text-sm">
                {(detail.assessment.fields ?? [])
                  .filter((field) => field.status === "present")
                  .map((field) => (
                    <div key={field.key} className={ROW}>
                      <p>{field.label} · {(field.evidence ?? []).map((item) => item.excerpt).filter(Boolean).join("；")}</p>
                      <p className="text-xs text-slate-500">资料原文，取值唯一</p>
                    </div>
                  ))}
                {accurateRows.map((row) => (
                  <div key={`${row.source}-${row.metric}`} className={ROW}>
                    <p>{row.metric} · {row.value}</p>
                    <p className="text-xs text-slate-500">{[row.condition, row.source].filter(Boolean).join(" · ")}</p>
                  </div>
                ))}
                {detail.facts
                  .filter((fact) => fact.value && !fact.value.includes("待补充"))
                  .map((fact) => (
                    <div key={fact.id} className={ROW}>
                      <p>{fieldLabels[fact.claim] || fact.claim} · {fact.value}{fact.conditions ? `（${fact.conditions}）` : ""}</p>
                      <p className="text-xs text-slate-500">已确认事实</p>
                    </div>
                  ))}
                {(detail.assessment.fields ?? []).every((field) => field.status !== "present") && accurateRows.length === 0 && detail.facts.length === 0 ? (
                  <p className="text-slate-500">资料里还没有带口径的结构化条目。</p>
                ) : null}
              </div>
              {detail.brief?.goal || detail.brief?.audience ? (
                <p className="mt-3 text-xs text-slate-500">
                  {[detail.brief?.goal ? `推广目标 ${detail.brief.goal}` : "", detail.brief?.audience ? `受众 ${detail.brief.audience}` : ""].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {assessed && detail.actions.confirm ? (
                <>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1 text-sm">推广目标<input className={FIELD} value={goal} onChange={(event) => setGoal(event.target.value)} /></label>
                    <label className="grid gap-1 text-sm">目标受众<input className={FIELD} value={audience} onChange={(event) => setAudience(event.target.value)} /></label>
                  </div>
                  <button
                    type="button"
                    className={`mt-3 ${BTN}`}
                    onClick={() =>
                      void run(`/projects/${projectId}/promotion-packages/${packageId}/facts`, {
                        expected_revision: detail.revision,
                        goal,
                        audience,
                        facts: factsForConfirm(),
                        adopted_candidate_ids: adopted,
                      })
                    }
                  >
                    压缩为事实条目
                  </button>
                </>
              ) : (
                <p className="mt-2 text-sm text-slate-500">{assessed ? "当前不能修改已确认事实。" : "补充完成后，再压缩成事实条目。"}</p>
              )}
            </section>
            ) : null}
          </div>
        </aside>
      ) : null}
      </div>

      <section role="tabpanel" id="panel-outputs" aria-labelledby="tab-outputs" tabIndex={0} hidden={currentStage !== 1} className={`${SURFACE} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">{STAGES[1].title}</h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN_LINE}
              disabled={!detail.actions.generate || selectedProducts.length !== 1}
              onClick={() => {
                console.info("[promotion] generate", { packageId, mode: "single", products: selectedProducts });
                void run(`/projects/${projectId}/promotion-packages/${packageId}/generate`, {
                  expected_revision: detail.revision,
                  products: selectedProducts,
                });
              }}
            >
              单一驱动生成
            </button>
            <button
              type="button"
              className={BTN}
              disabled={!detail.actions.generate || selectedProducts.length < 2}
              onClick={() => {
                console.info("[promotion] generate", { packageId, mode: "batch", products: selectedProducts });
                void run(`/projects/${projectId}/promotion-packages/${packageId}/generate`, {
                  expected_revision: detail.revision,
                  products: selectedProducts,
                });
              }}
            >
              批量驱动生成{selectedProducts.length > 1 ? `（${selectedProducts.length}）` : ""}
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-slate-500">{detail.brief_version ? STAGES[1].hint : "请先在第一步确认用于写稿的资料。"}</p>
        <div className="mt-4 space-y-4">
          {outputRows(detail).map(({ product, state }) => {
            const head = (state.versions || []).find((item) => item.output_id === state.head_output_id);
            const productActions = detail.actions.products?.[product] || {};
            const missing = (detail.assessment.fields ?? []).filter((field) =>
              field.blocks?.includes(product) && !detail.facts.some((fact) => fact.claim === field.key && fact.value.trim()),
            );
            const blockedByFacts = missing.length > 0 && !head;
            const label = promotionProductLabel(product);
            const chosen = selectedProducts.includes(product);
            return (
              <article key={product} className={`rounded-2xl border p-3 ${chosen ? "border-blue-500 bg-blue-50/80 ring-1 ring-blue-500 dark:bg-blue-950/40" : "border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40"}`}>
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`选择${label}`}
                    checked={chosen}
                    disabled={blockedByFacts}
                    onChange={(event) =>
                      setSelectedProducts((current) =>
                        event.target.checked
                          ? current.includes(product) ? current : [...current, product]
                          : current.filter((item) => item !== product),
                      )
                    }
                  />
                  <h3 className="text-sm font-medium">
                    {label} · {LABELS[state.status] || state.status}
                  </h3>
                </div>
                {!head && missing.length ? (
                  <p className="mt-2 text-sm text-amber-700">
                    待补充：{missing.map((field) => field.label).join("、")}。
                    <button
                      type="button"
                      className="ml-2 underline"
                      onClick={() => {
                        setDetailStep(2);
                        setStage(0);
                        window.requestAnimationFrame(() => document.getElementById("step-fill")?.scrollIntoView({ block: "nearest" }));
                      }}
                    >
                      去补资料
                    </button>
                  </p>
                ) : !head && detail.steps.some((step) => step.step_key === `generate:${product}` && step.status === "failed") ? (
                  <p className="mt-2 text-sm text-amber-700">上次生成失败，勾选后可再次生成。</p>
                ) : null}
                {head ? <textarea
                  aria-label={promotionProductLabel(product)}
                  readOnly={!productActions.revise}
                  className={`mt-2 h-40 w-full p-2 text-sm ${FIELD}`}
                  value={drafts[product] ?? head?.content ?? ""}
                  onChange={(event) => setDrafts((current) => ({ ...current, [product]: event.target.value }))}
                /> : <p className="mt-2 text-sm text-slate-500">草稿生成后可在这里查看。</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {productActions.revise && head ? (
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      onClick={() =>
                        void run(`/projects/${projectId}/promotion-packages/${packageId}/revise`, {
                          expected_revision: detail.revision,
                          output_id: head.output_id,
                          expected_version: head.version,
                          content: drafts[product] ?? head?.content ?? "",
                          fact_ids: head.fact_ids,
                        })
                      }
                    >
                      保存修订
                    </button>
                  ) : null}
                  {productActions.submit && head ? (
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      disabled={drafts[product] !== undefined && drafts[product] !== head.content}
                      onClick={() =>
                        void run(`/projects/${projectId}/promotion-packages/${packageId}/reviews`, {
                          expected_revision: detail.revision,
                          output_id: head.output_id,
                          expected_version: head.version,
                          action: "submit",
                        })
                      }
                    >
                      提交审核
                    </button>
                  ) : null}
                  {productActions.reject && head ? (
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      disabled={drafts[product] !== undefined && drafts[product] !== head.content}
                      onClick={() =>
                        void run(`/projects/${projectId}/promotion-packages/${packageId}/reviews`, {
                          expected_revision: detail.revision,
                          output_id: head.output_id,
                          expected_version: head.version,
                          action: "reject",
                          comment,
                        })
                      }
                    >
                      退回
                    </button>
                  ) : null}
                  {productActions.approve && head ? (
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                      disabled={drafts[product] !== undefined && drafts[product] !== head.content}
                      onClick={() =>
                        void run(`/projects/${projectId}/promotion-packages/${packageId}/reviews`, {
                          expected_revision: detail.revision,
                          output_id: head.output_id,
                          expected_version: head.version,
                          action: "approve",
                        })
                      }
                    >
                      批准
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {Object.values(detail.actions.products ?? {}).some((actions) => actions.reject) ? <input
          aria-label="退回意见"
          className={`mt-3 w-full text-sm ${FIELD}`}
          placeholder="退回意见"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        /> : null}
        {hasApproved ? <button type="button" className={`mt-4 ${BTN_LINE}`} onClick={() => setStage(2)}>选择已批准的文件</button> : null}
      </section>

      <section role="tabpanel" id="panel-export" aria-labelledby="tab-export" tabIndex={0} hidden={currentStage !== 2} className={`${SURFACE} p-5`}>
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <div>
            <h2 className="font-medium">{STAGES[2].title}</h2>
            <p className="mt-1 text-sm text-slate-500">
              {hasApproved ? STAGES[2].hint : saveIds.length ? "已有生成稿，可先保存到项目文件夹。下载需完成出品审核。" : "暂无可下载的文件。请先完成出品审核。"}
            </p>
            {conflicts.length > 0 ? (
              <p className="mt-2 text-sm text-amber-700">
                所选文件中有版本已失去批准状态，请取消勾选。
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={BTN_LINE}
                disabled={!saveIds.length || detail.role === "viewer"}
                onClick={() => void saveToProject()}
              >
                保存项目
              </button>
              <button
                type="button"
                className={BTN}
                disabled={!downloadIds.length || conflicts.length > 0}
                onClick={() => void download().catch(() => setError("下载失败，请重试"))}
              >
                {downloadIds.length ? `下载 ${downloadIds.length} 个文件（ZIP）` : "下载推广包"}
              </button>
            </div>
            {saveHint ? <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300">{saveHint}</p> : null}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium">可导出内容</h3>
            <div className="mt-3 space-y-2 text-sm">
              {outputRows(detail).map(({ product, state }) => {
                const head = (state.versions || []).find((item) => item.output_id === state.head_output_id);
                const label = promotionProductLabel(product);
                const checked = chosenProducts.includes(product);
                return (
                  <label key={product} className={`flex items-center gap-2 rounded-2xl border px-3 py-2 ${checked ? "border-blue-500 bg-blue-50/80 dark:bg-blue-950/40" : "border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-950/40"}`}>
                    <input
                      type="checkbox"
                      aria-label={`导出${label}`}
                      checked={checked}
                      onChange={(event) =>
                        setExportSelection((current) => {
                          const base = current ?? outputRows(detail).map((item) => item.product);
                          return event.target.checked
                            ? base.includes(product) ? base : [...base, product]
                            : base.filter((item) => item !== product);
                        })
                      }
                    />
                    <span className="min-w-0">
                      {label}
                      <span className="mt-0.5 block text-xs text-slate-500">
                        {LABELS[head?.status || state.status] || head?.status || state.status}
                        {head?.version ? ` · v${head.version}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
              {Object.keys(detail.products_state || {}).length === 0 ? (
                <p className="text-sm text-slate-500">这个任务还没有出品。</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      </fieldset>
      </div>
    </main>
    </div>
    <div className="hidden h-full min-h-0 lg:flex">{renderProjectFilesRail(true)}</div>
    </div>
  );
}
