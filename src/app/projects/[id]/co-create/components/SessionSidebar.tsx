"use client";

import { useState, type ReactNode } from "react";
import type { ChatSession } from "@/app/chat/chat-types";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { isProjectCoCreateSession, titleFromSession } from "@/lib/chat-session-utils";

type PendingConfirm =
  | { kind: "archive"; sessionId: string; sessionTitle: string }
  | { kind: "delete"; sessionId: string; sessionTitle: string };

type Props = {
  sessions: ChatSession[];
  activeId: string | null;
  loading: boolean;
  syncError: string;
  projectId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
};

export function SessionSidebar({
  sessions,
  activeId,
  loading,
  syncError,
  projectId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onArchive,
}: Props) {
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const filtered = sessions.filter(
    (s) =>
      !s.archived &&
      s.selectedProjectId === projectId &&
      isProjectCoCreateSession(s),
  );

  return (
    <>
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-slate-300 bg-slate-200 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-300 p-4 dark:border-slate-700">
        <div>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">共创会话</span>
          <p className="mt-0.5 text-[10px] text-slate-500">项目内文件协作历史</p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white transition hover:bg-blue-500"
        >
          + 新建
        </button>
      </div>
      {loading ? <p className="px-4 py-4 text-xs text-slate-500">加载会话…</p> : null}
      {syncError ? (
        <p className="mx-4 mt-2 rounded-lg border border-amber-400/40 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          同步异常：{syncError.slice(0, 80)}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {filtered.length === 0 && !loading ? (
          <p className="px-4 py-6 text-xs leading-relaxed text-slate-500">
            暂无共创会话，点击「新建」开始第一次协作。
          </p>
        ) : null}
        {filtered.map((session) => {
          const sessionTitle = titleFromSession(session, "新共创");
          const fileCount =
            new Set([...(session.roundFileIds ?? []), ...(session.pinnedFileIds ?? [])]).size;
          const pending = (session.pendingProposalIds ?? []).length;
          return (
            <div
              key={session.id}
              onClick={() => onSelect(session.id)}
              className={`group cursor-pointer border-b border-slate-300 px-4 py-3 transition dark:border-slate-700/50 ${
                session.id === activeId
                  ? "bg-slate-300/70 dark:bg-slate-700/70"
                  : "hover:bg-slate-300/40 dark:hover:bg-slate-700/40"
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs">📁</span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{sessionTitle}</span>
                  <div className="mt-0.5 flex items-center justify-between gap-1">
                    <span className="truncate text-[10px] text-slate-500">
                      文件 {fileCount} 个
                      {pending > 0 ? ` · 待确认 ${pending}` : ""}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                      <button
                        type="button"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = window.prompt("会话标题", session.title);
                          if (next?.trim()) onRename(session.id, next.trim());
                        }}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-300/60 hover:text-blue-600 dark:hover:bg-slate-600/60"
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        title="归档"
                        aria-label={`归档会话：${sessionTitle}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingConfirm({
                            kind: "archive",
                            sessionId: session.id,
                            sessionTitle,
                          });
                        }}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-300/60 hover:text-amber-600 dark:hover:bg-slate-600/60"
                      >
                        <ArchiveIcon />
                      </button>
                      <button
                        type="button"
                        title="删除"
                        aria-label={`删除会话：${sessionTitle}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingConfirm({
                            kind: "delete",
                            sessionId: session.id,
                            sessionTitle,
                          });
                        }}
                        className="rounded p-0.5 text-slate-500 hover:bg-slate-300/60 hover:text-red-500 dark:hover:bg-slate-600/60"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
    <ConfirmDialog
      open={pendingConfirm?.kind === "archive"}
      title="归档共创会话"
      description={
        pendingConfirm?.kind === "archive"
          ? `确定归档「${pendingConfirm.sessionTitle}」？\n会话将从列表中隐藏，已保存的项目文件不受影响。`
          : ""
      }
      confirmLabel="归档"
      onCancel={() => setPendingConfirm(null)}
      onConfirm={() => {
        if (pendingConfirm?.kind === "archive") onArchive(pendingConfirm.sessionId);
        setPendingConfirm(null);
      }}
    />
    <ConfirmDialog
      open={pendingConfirm?.kind === "delete"}
      title="删除共创会话"
      description={
        pendingConfirm?.kind === "delete"
          ? `确定删除「${pendingConfirm.sessionTitle}」？\n对话记录将被永久删除，已保存的项目文件不受影响。`
          : ""
      }
      confirmLabel="删除"
      destructive
      onCancel={() => setPendingConfirm(null)}
      onConfirm={() => {
        if (pendingConfirm?.kind === "delete") onDelete(pendingConfirm.sessionId);
        setPendingConfirm(null);
      }}
    />
    </>
  );
}

function SessionIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function PencilIcon() {
  return (
    <SessionIcon>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </SessionIcon>
  );
}

function ArchiveIcon() {
  return (
    <SessionIcon>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </SessionIcon>
  );
}

function TrashIcon() {
  return (
    <SessionIcon>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </SessionIcon>
  );
}
