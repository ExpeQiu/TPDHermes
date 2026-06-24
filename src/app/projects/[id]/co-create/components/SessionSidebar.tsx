"use client";

import type { ChatSession } from "@/app/chat/chat-types";
import { isProjectCoCreateSession, titleFromSession } from "@/lib/chat-session-utils";

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
  const filtered = sessions.filter(
    (s) =>
      !s.archived &&
      s.selectedProjectId === projectId &&
      isProjectCoCreateSession(s),
  );

  return (
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
                  <span className="block truncate text-sm font-medium">
                    {titleFromSession(session, "新共创")}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    文件 {fileCount} 个
                    {pending > 0 ? ` · 待确认 ${pending}` : ""}
                  </span>
                </div>
                <div className="flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = window.prompt("会话标题", session.title);
                      if (next?.trim()) onRename(session.id, next.trim());
                    }}
                    className="text-[10px] text-slate-500 hover:text-blue-600"
                  >
                    改
                  </button>
                  <button
                    type="button"
                    title="归档"
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive(session.id);
                    }}
                    className="text-[10px] text-slate-500 hover:text-amber-600"
                  >
                    档
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(session.id);
                    }}
                    className="text-[10px] text-slate-500 hover:text-red-500"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
