"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiGet } from "@/lib/api";
import {
  depositBrainstormOutput,
  fetchBrainstormHealth,
  runBrainstorm,
  type BrainstormHealth,
  type BrainstormRunResult,
} from "@/lib/brainstorm-api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import {
  BrainstormSetupPanel,
  buildBrainstormTopic,
  type BrainstormAttachment,
  type BrainstormSetupValues,
} from "./components/BrainstormSetupPanel";
import { BrainstormResultPanel } from "./components/BrainstormResultPanel";

type ProjectBrief = {
  id: string;
  name: string;
  background?: string | null;
};

type AttachmentRow = BrainstormAttachment & {
  project_id?: string;
  created_at?: string | null;
};

export default function ProjectBrainstormPage() {
  const params = useParams();
  const projectId = String(params?.id || "");

  const [project, setProject] = useState<ProjectBrief | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [health, setHealth] = useState<BrainstormHealth | null>(null);
  const [setup, setSetup] = useState<BrainstormSetupValues>({
    topic: "",
    description: "",
    rounds: 2,
    demo: true,
    pack: "nev-tech",
    selectedAttachmentIds: [],
    discussionMode: "round_robin",
    consensusEnabled: false,
    consensusThreshold: 0.7,
    proRoleIds: [],
    conRoleIds: [],
    judgeRoleId: "",
    moderatorEnabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrainstormRunResult | null>(null);
  /** setup：配置表单；session：运行中 / 结果（逐条发言） */
  const [phase, setPhase] = useState<"setup" | "session">("setup");
  const [showTrajectory, setShowTrajectory] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOutputId, setSavedOutputId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const patchSetup = useCallback((patch: Partial<BrainstormSetupValues>) => {
    setSetup((prev) => ({ ...prev, ...patch }));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setAttachmentsLoading(true);

    Promise.all([
      apiGet<ProjectBrief>(`/projects/${projectId}`),
      fetchBrainstormHealth().catch(() => null),
      apiGet<AttachmentRow[]>(`/projects/${projectId}/attachments`).catch(
        () => [] as AttachmentRow[],
      ),
    ])
      .then(([proj, h, atts]) => {
        if (cancelled) return;
        setProject(proj);
        setHealth(h);
        setAttachments(Array.isArray(atts) ? atts : []);
        const bg = (proj.background || "").trim();
        setSetup((prev) => ({
          ...prev,
          demo: h?.mock_default ?? prev.demo,
          topic: prev.topic || `围绕项目「${proj.name}」做多视角策略头脑风暴`,
          description:
            prev.description ||
            (bg
              ? bg.slice(0, 500)
              : `目标：输出可落地的 Master Plan（概念 slogan + 三步行动）。`),
        }));
        console.info("[brainstorm] 页面已加载", {
          projectId,
          ready: h?.ready,
          mockDefault: h?.mock_default,
          attachmentCount: Array.isArray(atts) ? atts.length : 0,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        console.warn("[brainstorm] 项目加载失败", { projectId, err });
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setAttachmentsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const onRun = useCallback(async () => {
    if (!projectId) return;
    const selectedNames = attachments
      .filter((a) => setup.selectedAttachmentIds.includes(a.id))
      .map((a) => a.original_filename);
    const fullTopic = buildBrainstormTopic(setup, selectedNames);
    if (!fullTopic.trim()) return;

    setRunning(true);
    setPhase("session");
    setError(null);
    setResult(null);
    setSavedOutputId(null);
    setSaveError(null);
    setShowTrajectory(false);
    try {
      console.info("[brainstorm] 配置提交", {
        projectId,
        rounds: setup.rounds,
        demo: setup.demo,
        pack: setup.pack,
        discussionMode: setup.discussionMode,
        consensusEnabled: setup.consensusEnabled,
        attachmentIds: setup.selectedAttachmentIds,
        topicLen: fullTopic.length,
      });
      const debateConfig =
        setup.discussionMode === "debate"
          ? {
              pro_role_ids: setup.proRoleIds,
              con_role_ids: setup.conRoleIds,
              judge_role_id: setup.judgeRoleId || null,
            }
          : null;
      const data = await runBrainstorm({
        topic: fullTopic,
        project_id: projectId,
        pack: setup.pack,
        rounds: setup.rounds,
        demo: setup.demo,
        discussion_mode: setup.discussionMode,
        consensus_enabled: setup.consensusEnabled,
        consensus_threshold: setup.consensusThreshold,
        debate_config: debateConfig,
        moderator_enabled: setup.moderatorEnabled,
        attachment_ids: setup.selectedAttachmentIds,
      });
      setResult(data);
      console.info("[brainstorm] 切换至结果视图（逐条 Markdown）", {
        runId: data.run_id,
        deliveryLen: data.delivery_markdown?.length ?? 0,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPhase("setup");
      console.warn("[brainstorm] 运行失败", { projectId, err });
    } finally {
      setRunning(false);
    }
  }, [attachments, projectId, setup]);

  const onReconfigure = useCallback(() => {
    setPhase("setup");
    setShowTrajectory(false);
    console.info("[brainstorm] 返回配置", { projectId, hasResult: Boolean(result) });
  }, [projectId, result]);

  const onDeposit = useCallback(async () => {
    if (!projectId || !result?.delivery_markdown?.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await depositBrainstormOutput({
        project_id: projectId,
        content: result.delivery_markdown,
        title: result.title || undefined,
        topic: setup.topic.trim() || undefined,
        ma_run_id: result.run_id || null,
        discussion_mode: result.discussion_mode || setup.discussionMode,
        pack: setup.pack,
        mock: result.mock,
        trajectory_markdown: result.trajectory_markdown || null,
      });
      setSavedOutputId(saved.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      console.warn("[brainstorm] 沉淀失败", { projectId, err });
    } finally {
      setSaving(false);
    }
  }, [projectId, result, setup.discussionMode, setup.pack, setup.topic]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-6 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
        <p className="text-center text-slate-500">加载头脑风暴…</p>
      </main>
    );
  }

  const engineHint = health
    ? health.ready
      ? `引擎就绪（${health.http_ok ? "HTTP" : "SDK"}）· AI 由 multi-agent 提供 · 默认 ${health.mock_default ? "Mock" : "Live"}`
      : "引擎未就绪：请启动 multi-agent Web，或配置 MULTI_AGENT_ROOT"
    : null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-amber-50/40 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={`mx-auto w-full ${CONTENT_MAX_CLASS}`}>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          <Link href="/projects" className="hover:text-slate-800 dark:hover:text-slate-200">
            项目
          </Link>
          <span>/</span>
          <Link
            href={`/projects/${projectId}`}
            className="hover:text-slate-800 dark:hover:text-slate-200"
          >
            {project?.name || "详情"}
          </Link>
          <span>/</span>
          <span className="text-slate-800 dark:text-slate-200">头脑风暴</span>
        </div>

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-700/80 dark:text-amber-400/80">
              Roundtable
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              头脑风暴
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              先配置议题与参考材料，再启动多角色圆桌；辩论结束后收敛为唯一 Master Plan。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link
              href={`/projects/${projectId}/co-create`}
              className="rounded-xl border border-indigo-300 bg-indigo-50 px-3 py-2 text-indigo-900 transition hover:bg-indigo-100 dark:border-indigo-600/50 dark:bg-indigo-950/40 dark:text-indigo-200"
            >
              项目共创
            </Link>
            <Link
              href={`/projects/${projectId}`}
              className="rounded-xl border border-slate-300 px-3 py-2 text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              项目控制台
            </Link>
          </div>
        </header>

        {error ? (
          <div className="mt-4 rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {phase === "setup" ? (
          <div className="mt-6">
            <BrainstormSetupPanel
              projectName={project?.name || "未命名项目"}
              projectBackground={project?.background}
              attachments={attachments}
              attachmentsLoading={attachmentsLoading}
              values={setup}
              onChange={patchSetup}
              running={running}
              engineReady={health?.ready ?? null}
              engineHint={engineHint}
              onSubmit={() => void onRun()}
            />
          </div>
        ) : null}

        {phase === "session" && running && !result ? (
          <section className="mt-6">
            <div className="rounded-3xl border border-slate-200 bg-white/80 p-8 text-center dark:border-slate-800 dark:bg-slate-900/50">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
              <p className="mt-4 text-sm font-medium text-slate-800 dark:text-slate-200">
                圆桌进行中…
              </p>
              <p className="mt-2 text-xs text-slate-500">
                多角色依次发言，完成后将逐条渲染各专家回复
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {setup.topic.trim() || "未命名议题"} · {setup.discussionMode} ·{" "}
                {setup.rounds} 轮
              </p>
            </div>
          </section>
        ) : null}

        {phase === "session" && result ? (
          <BrainstormResultPanel
            result={result}
            projectId={projectId}
            saving={saving}
            savedOutputId={savedOutputId}
            saveError={saveError}
            showTrajectory={showTrajectory}
            onToggleTrajectory={() => setShowTrajectory((v) => !v)}
            onDeposit={() => void onDeposit()}
            onReconfigure={onReconfigure}
          />
        ) : null}
      </div>
    </main>
  );
}
