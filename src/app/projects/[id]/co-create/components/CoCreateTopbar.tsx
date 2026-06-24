"use client";

import Link from "next/link";
import type { CoCreateSaveState } from "@/app/projects/[id]/co-create/co-create-types";
import { FileReferenceBar } from "@/app/projects/[id]/co-create/components/FileReferenceBar";
import { ProjectContextBar } from "@/app/projects/[id]/co-create/components/ProjectContextBar";
import type { ProjectContextResponse } from "@/lib/chat-context";
import type { ProjectFileItem } from "@/lib/co-create-api";

type Props = {
  projectName: string;
  projectId: string;
  saveState: CoCreateSaveState;
  agentChangeSummary?: string | null;
  onUndoAgentChange?: () => void;
  undoButtonLabel?: string;
  undoDisabled?: boolean;
  onToggleSessions?: () => void;
  sessionsOpen?: boolean;
  projectContext: ProjectContextResponse | null;
  outputCount: number;
  pinnedFileIds: string[];
  roundFileIds: string[];
  files: ProjectFileItem[];
  onRemoveFileRef: (fileKey: string, scope: "pinned" | "round") => void;
};

const saveStateLabel: Record<CoCreateSaveState, string> = {
  idle: "已就绪",
  saving: "正在保存…",
  saved: "已自动保存",
  error: "保存异常",
  pending_apply: "Agent 正在应用",
};

export function CoCreateTopbar({
  projectName,
  projectId,
  saveState,
  agentChangeSummary,
  onUndoAgentChange,
  undoButtonLabel = "撤销",
  undoDisabled,
  onToggleSessions,
  sessionsOpen,
  projectContext,
  outputCount,
  pinnedFileIds,
  roundFileIds,
  files,
  onRemoveFileRef,
}: Props) {
  return (
    <header className="shrink-0 border-b border-slate-300 bg-slate-200/80 px-4 py-2.5 dark:border-slate-700 dark:bg-slate-800/80">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {onToggleSessions ? (
          <button
            type="button"
            onClick={onToggleSessions}
            className="text-sm text-slate-500 transition hover:text-slate-900 dark:hover:text-white lg:hidden"
          >
            {sessionsOpen ? "◀" : "▶"}
          </button>
        ) : null}
        <Link
          href={`/projects/${projectId}`}
          className="shrink-0 text-sm text-slate-500 transition hover:text-slate-900 dark:hover:text-white"
        >
          ← 项目
        </Link>
        <span className="text-slate-400">·</span>
        <ProjectContextBar
          embedded
          projectName={projectName}
          context={projectContext}
          outputCount={outputCount}
        />
        <span className="text-slate-400">·</span>
        <FileReferenceBar
          embedded
          pinnedFileIds={pinnedFileIds}
          roundFileIds={roundFileIds}
          files={files}
          onRemove={onRemoveFileRef}
        />
        {agentChangeSummary ? (
          <>
            <span className="text-slate-400">·</span>
            <span className="truncate text-[11px] text-slate-500 dark:text-slate-300">
              {agentChangeSummary}
            </span>
            {onUndoAgentChange ? (
              <button
                type="button"
                disabled={undoDisabled}
                onClick={onUndoAgentChange}
                className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                {undoButtonLabel}
              </button>
            ) : null}
          </>
        ) : null}
        <div className="min-w-0 flex-1" />
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${
            saveState === "pending_apply"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
              : saveState === "error"
                ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
          }`}
        >
          {saveStateLabel[saveState]}
        </span>
      </div>
    </header>
  );
}
