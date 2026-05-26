"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

import { accentBlueSoft, accentEmeraldSoft, accentLink, accentRedSoft } from "@/lib/theme-text";
import { apiPost } from "@/lib/api";
import { triggerWorkshopOutputDownload } from "@/lib/workshop-output-artifact";
import { trackUsage } from "@/lib/usage-tracker";

type QuickActionRole = "user" | "assistant" | "system";

type AdoptionLevel = "full" | "partial" | "reject";

type FeedbackReaction = "thumbs_up" | "thumbs_down" | "adopt" | "rewrite";

type KbHarvestResponse = {
  ok?: boolean;
  doc_id?: string;
  message?: string;
  error?: string;
};

type FeedbackSubmitResponse = {
  ok?: boolean;
  feedback?: {
    id?: string;
    adoption_level?: AdoptionLevel;
    reaction_type?: FeedbackReaction;
    memory_line?: string;
  };
};

type OutputVersionResponse = {
  id: string;
  title?: string | null;
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function titleFromContent(content: string, maxLen = 24): string {
  const line = (content.split(/\n/)[0] ?? content).trim().replace(/\s+/g, " ");
  if (!line) return "对话摘录";
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}…`;
}

export function ChatMessageQuickActions({
  content,
  role,
  messageId,
  align = "start",
  exportTitle,
  collectionName,
  projectId,
  sessionId,
  runId,
  outputId,
  scenarioId,
  sourceOutputId,
  onRegenerate,
  actionsDisabled = false,
  initialFeedbackLevel,
}: {
  content: string;
  role: QuickActionRole;
  messageId?: string;
  align?: "start" | "end";
  exportTitle?: string;
  collectionName?: string;
  projectId?: string;
  sessionId?: string | null;
  runId?: string;
  outputId?: string;
  scenarioId?: string;
  /** 创作边界选中的来源输出物，用于保存新版本 */
  sourceOutputId?: string | null;
  /** 仅助手消息：基于上一条用户问题重新生成回复 */
  onRegenerate?: (assistantMessageId: string) => void | Promise<void>;
  actionsDisabled?: boolean;
  initialFeedbackLevel?: AdoptionLevel | null;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [kbState, setKbState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [kbHint, setKbHint] = useState<string | null>(null);
  const [exportFlash, setExportFlash] = useState(false);
  const [versionState, setVersionState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [versionHint, setVersionHint] = useState<string | null>(null);
  const [feedbackLevel, setFeedbackLevel] = useState<AdoptionLevel | null>(
    initialFeedbackLevel ?? null,
  );
  const [feedbackState, setFeedbackState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [feedbackHint, setFeedbackHint] = useState<string | null>(null);

  const trimmed = content.trim();
  const canKb = role !== "system" && Boolean(collectionName?.trim());
  const canSaveVersion =
    role === "assistant" && Boolean(projectId?.trim()) && Boolean(sourceOutputId?.trim());
  const fileTitle = exportTitle?.trim() || titleFromContent(trimmed);
  const showFeedback = role === "assistant";

  const submitFeedback = useCallback(
    async (reaction: FeedbackReaction, reason?: string) => {
      if (!trimmed || feedbackState === "busy") return;
      setFeedbackState("busy");
      setFeedbackHint(null);
      try {
        const res = await apiPost<FeedbackSubmitResponse>("/feedback", {
          session_id: sessionId ?? undefined,
          message_id: messageId,
          run_id: runId,
          output_id: outputId,
          project_id: projectId,
          scenario_id: scenarioId,
          reaction_type: reaction,
          reason_text: reason,
          source_excerpt: trimmed.slice(0, 2000),
          save_experience: reaction === "adopt" || reaction === "thumbs_up",
          experience_title: fileTitle,
        });
        const level = res.feedback?.adoption_level;
        if (level === "full" || level === "partial" || level === "reject") {
          setFeedbackLevel(level);
        }
        setFeedbackState("ok");
        setFeedbackHint(
          reaction === "rewrite"
            ? "已记录，可点「再次生成」重写"
            : level === "full"
              ? "已采纳"
              : level === "reject"
                ? "已记录不采纳"
                : "反馈已记录",
        );
        trackUsage({
          eventName:
            reaction === "rewrite"
              ? "chat_feedback_rewrite"
              : reaction === "adopt"
                ? "chat_feedback_adopt"
                : reaction === "thumbs_up"
                  ? "chat_feedback_thumbs_up"
                  : "chat_feedback_thumbs_down",
          feature: "chat_feedback",
          action:
            reaction === "rewrite"
              ? "rewrite"
              : reaction === "adopt"
                ? "adopt"
                : reaction === "thumbs_up"
                  ? "thumbs_up"
                  : "thumbs_down",
          projectId: projectId,
          properties: {
            run_id: runId,
            message_id: messageId,
            adoption_level: level,
          },
        });
        console.info("[chat] 反馈已提交", {
          reaction,
          run_id: runId,
          message_id: messageId,
          memory_line: res.feedback?.memory_line,
        });
        if (reaction === "rewrite" && onRegenerate && messageId) {
          await onRegenerate(messageId);
        }
      } catch (e) {
        setFeedbackState("fail");
        setFeedbackHint(e instanceof Error ? e.message : String(e));
        console.warn("[chat] 反馈提交失败", e);
      } finally {
        window.setTimeout(() => {
          setFeedbackState("idle");
        }, 3000);
      }
    },
    [
      feedbackState,
      fileTitle,
      messageId,
      onRegenerate,
      outputId,
      projectId,
      runId,
      scenarioId,
      sessionId,
      trimmed,
    ],
  );

  const onCopy = useCallback(async () => {
    if (!trimmed) return;
    const ok = await copyText(trimmed);
    setCopyState(ok ? "ok" : "fail");
    window.setTimeout(() => setCopyState("idle"), 2000);
    console.info("[chat] 消息复制", { role, ok, len: trimmed.length });
  }, [role, trimmed]);

  const onExport = useCallback(() => {
    if (!trimmed) return;
    triggerWorkshopOutputDownload(trimmed, "markdown", fileTitle);
    setExportFlash(true);
    window.setTimeout(() => setExportFlash(false), 1500);
    console.info("[chat] 消息导出", { role, title: fileTitle });
  }, [fileTitle, role, trimmed]);

  const onSaveKb = useCallback(async () => {
    const collection = collectionName?.trim();
    if (!trimmed || !collection) return;
    setKbState("busy");
    setKbHint(null);
    try {
      const res = await apiPost<KbHarvestResponse>("/kb/entries", {
        collection_name: collection,
        project_id: projectId?.trim() || "__all__",
        title: fileTitle,
        content: trimmed,
        summary: trimmed.slice(0, 280),
        source: "hermes_chat",
        domain: "internal_methodology",
        published: false,
        metadata: {
          harvested_from_user_confirmed: true,
          chat_session_id: sessionId ?? undefined,
          message_role: role,
        },
      });
      if (res.ok === false) {
        throw new Error(res.message || res.error || "入库失败");
      }
      setKbState("ok");
      setKbHint(res.doc_id ? `草稿 ${res.doc_id}` : "已写入草稿");
      console.info("[chat] 消息存入知识库", {
        collection,
        doc_id: res.doc_id,
        project_id: projectId,
      });
    } catch (e) {
      setKbState("fail");
      setKbHint(e instanceof Error ? e.message : String(e));
      console.warn("[chat] 存入知识库失败", e);
    } finally {
      window.setTimeout(() => {
        setKbState("idle");
        setKbHint(null);
      }, 4000);
    }
  }, [collectionName, fileTitle, projectId, role, sessionId, trimmed]);

  const onSaveOutputVersion = useCallback(async () => {
    const pid = projectId?.trim();
    const baseId = sourceOutputId?.trim();
    if (!trimmed || !pid || !baseId || versionState === "busy") return;
    setVersionState("busy");
    setVersionHint(null);
    try {
      const res = await apiPost<OutputVersionResponse>(
        `/projects/${pid}/outputs/${baseId}/versions`,
        { content: trimmed, title: fileTitle },
      );
      setVersionState("ok");
      setVersionHint(res.id ? `新版本 ${res.id.slice(0, 8)}…` : "已保存新版本");
      console.info("[chat-output-context] 保存输出版本", {
        base_output_id: baseId,
        new_output_id: res.id,
        content_len: trimmed.length,
        project_id: pid,
        run_id: runId,
      });
    } catch (e) {
      setVersionState("fail");
      setVersionHint(e instanceof Error ? e.message : String(e));
      console.warn("[chat-output-context] 保存输出版本失败", e);
    } finally {
      window.setTimeout(() => {
        setVersionState("idle");
        setVersionHint(null);
      }, 5000);
    }
  }, [fileTitle, projectId, runId, sourceOutputId, trimmed, versionState]);

  if (!trimmed) return null;

  const btnClass =
    "rounded-md border border-slate-600/80 bg-slate-800/80 px-2 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";
  const feedbackActiveClass = (level: AdoptionLevel) =>
    feedbackLevel === level
      ? "border-emerald-500/80 bg-emerald-900/40 text-emerald-200"
      : "";

  return (
    <div
      className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${align === "end" ? "justify-end" : "justify-start"}`}
    >
      <span className="text-[10px] text-slate-500 mr-0.5">快捷操作</span>
      {showFeedback ? (
        <>
          <button
            type="button"
            className={`${btnClass} ${feedbackActiveClass("full")}`}
            disabled={actionsDisabled || feedbackState === "busy"}
            title="采纳此回复"
            onClick={() => void submitFeedback("thumbs_up")}
          >
            👍
          </button>
          <button
            type="button"
            className={`${btnClass} ${feedbackLevel === "reject" ? "border-red-500/80 bg-red-900/40 text-red-200" : ""}`}
            disabled={actionsDisabled || feedbackState === "busy"}
            title="不采纳此回复"
            onClick={() => void submitFeedback("thumbs_down")}
          >
            👎
          </button>
          <button
            type="button"
            className={`${btnClass} ${feedbackActiveClass("full")}`}
            disabled={actionsDisabled || feedbackState === "busy"}
            onClick={() => void submitFeedback("adopt", "用户点击采纳")}
          >
            采纳
          </button>
          <button
            type="button"
            className={btnClass}
            disabled={actionsDisabled || feedbackState === "busy"}
            onClick={() => void submitFeedback("rewrite", "用户请求重写")}
          >
            重写
          </button>
        </>
      ) : null}
      <button type="button" className={btnClass} onClick={() => void onCopy()} disabled={actionsDisabled}>
        {copyState === "ok" ? "✓ 已复制" : copyState === "fail" ? "复制失败" : "复制"}
      </button>
      <button type="button" className={btnClass} onClick={onExport} disabled={actionsDisabled}>
        {exportFlash ? "✓ 已导出" : "导出"}
      </button>
      {role === "assistant" && onRegenerate && messageId ? (
        <button
          type="button"
          className={btnClass}
          disabled={actionsDisabled}
          title="删除本条回复并基于上一条用户问题重新生成"
          onClick={() => void onRegenerate(messageId)}
        >
          {actionsDisabled ? "生成中…" : "再次生成"}
        </button>
      ) : null}
      {canSaveVersion ? (
        <button
          type="button"
          className={btnClass}
          disabled={actionsDisabled || versionState === "busy"}
          title="将本条回复保存为选中文档的新版本"
          onClick={() => void onSaveOutputVersion()}
        >
          {versionState === "busy"
            ? "保存中…"
            : versionState === "ok"
              ? "✓ 已存版本"
              : versionState === "fail"
                ? "保存失败"
                : "存为新版本"}
        </button>
      ) : null}
      {role !== "system" ? (
        <button
          type="button"
          className={btnClass}
          disabled={actionsDisabled || !canKb || kbState === "busy"}
          title={canKb ? `写入集合「${collectionName}」草稿` : "请在创作边界或 URL 中指定知识库集合"}
          onClick={() => void onSaveKb()}
        >
          {kbState === "busy"
            ? "入库中…"
            : kbState === "ok"
              ? "✓ 已入库"
              : kbState === "fail"
                ? "入库失败"
                : "存入知识库"}
        </button>
      ) : null}
      {feedbackHint ? (
        <span
          className={`text-[10px] ${feedbackState === "fail" ? accentRedSoft : accentEmeraldSoft}`}
        >
          {feedbackHint}
        </span>
      ) : null}
      {feedbackLevel && !feedbackHint ? (
        <span className={`text-[10px] ${accentBlueSoft}`}>
          反馈：{feedbackLevel === "full" ? "已采纳" : feedbackLevel === "reject" ? "不采纳" : "部分采纳"}
        </span>
      ) : null}
      {kbHint ? (
        <span
          className={`text-[10px] ${kbState === "fail" ? accentRedSoft : accentEmeraldSoft}`}
        >
          {kbHint}
          {kbState === "ok" && collectionName ? (
            <Link href="/knowledge" className={`ml-1 ${accentLink}`}>
              去知识库
            </Link>
          ) : null}
        </span>
      ) : null}
      {versionHint ? (
        <span
          className={`text-[10px] ${versionState === "fail" ? accentRedSoft : accentEmeraldSoft}`}
        >
          {versionHint}
          {versionState === "ok" && projectId ? (
            <Link href={`/projects/${projectId}`} className={`ml-1 ${accentLink}`}>
              打开项目
            </Link>
          ) : null}
        </span>
      ) : null}
      {!canKb && role !== "system" ? (
        <span className="text-[10px] text-slate-600">未绑定知识库集合</span>
      ) : null}
    </div>
  );
}
