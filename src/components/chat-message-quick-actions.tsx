"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

import { accentBlueSoft, accentEmeraldSoft, accentLink, accentRedSoft } from "@/lib/theme-text";
import { apiPost } from "@/lib/api";
import { triggerWorkshopOutputDownload } from "@/lib/workshop-output-artifact";

type QuickActionRole = "user" | "assistant" | "system";

type KbHarvestResponse = {
  ok?: boolean;
  doc_id?: string;
  message?: string;
  error?: string;
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
  onRegenerate,
  actionsDisabled = false,
}: {
  content: string;
  role: QuickActionRole;
  messageId?: string;
  align?: "start" | "end";
  exportTitle?: string;
  collectionName?: string;
  projectId?: string;
  sessionId?: string | null;
  /** 仅助手消息：基于上一条用户问题重新生成回复 */
  onRegenerate?: (assistantMessageId: string) => void | Promise<void>;
  actionsDisabled?: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [kbState, setKbState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [kbHint, setKbHint] = useState<string | null>(null);
  const [exportFlash, setExportFlash] = useState(false);

  const trimmed = content.trim();
  const canKb = role !== "system" && Boolean(collectionName?.trim());
  const fileTitle = exportTitle?.trim() || titleFromContent(trimmed);

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
        project_id: (projectId?.trim() || "__all__"),
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

  if (!trimmed) return null;

  const btnClass =
    "rounded-md border border-slate-600/80 bg-slate-800/80 px-2 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${align === "end" ? "justify-end" : "justify-start"}`}
    >
      <span className="text-[10px] text-slate-500 mr-0.5">快捷操作</span>
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
      {!canKb && role !== "system" ? (
        <span className="text-[10px] text-slate-600">未绑定知识库集合</span>
      ) : null}
    </div>
  );
}
