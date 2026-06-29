"use client";

import type { ReactNode } from "react";

type ToolbarButtonProps = {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
};

function ToolbarButton({ title, active, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded transition ${
        active
          ? "bg-slate-300/80 text-slate-900 dark:bg-slate-600 dark:text-white"
          : "text-slate-500 hover:bg-slate-300/60 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function UndoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
  );
}

function PanelLeftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path fill="currentColor" stroke="none" d="M3 5.5A1.5 1.5 0 0 1 4.5 4H8v16H4.5A1.5 1.5 0 0 1 3 18.5V5.5Z" />
    </svg>
  );
}

function PanelRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path fill="currentColor" stroke="none" d="M21 5.5A1.5 1.5 0 0 0 19.5 4H16v16h3.5A1.5 1.5 0 0 0 21 18.5V5.5Z" />
    </svg>
  );
}

type Props = {
  undoCount?: number;
  undoDisabled?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  redoDisabled?: boolean;
  sessionsOpen?: boolean;
  onToggleSessions?: () => void;
  filesPanelOpen?: boolean;
  onToggleFilesPanel?: () => void;
};

export function CoCreateTopbarToolbar({
  undoCount = 0,
  undoDisabled,
  onUndo,
  onRedo,
  redoDisabled = true,
  sessionsOpen = true,
  onToggleSessions,
  filesPanelOpen = true,
  onToggleFilesPanel,
}: Props) {
  const undoTitle = undoCount > 0 ? `撤销 Agent 变更 (${undoCount})` : "撤销 Agent 变更";

  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="flex items-center gap-0.5">
        <ToolbarButton
          title={undoTitle}
          disabled={undoDisabled || !onUndo}
          onClick={onUndo}
        >
          <UndoIcon />
        </ToolbarButton>
        <ToolbarButton
          title="重做"
          disabled={redoDisabled || !onRedo}
          onClick={onRedo}
        >
          <RedoIcon />
        </ToolbarButton>
      </div>

      <span className="mx-0.5 h-4 w-px bg-slate-300 dark:bg-slate-600" aria-hidden />

      <div className="flex items-center gap-0.5">
        {onToggleSessions ? (
          <ToolbarButton
            title={sessionsOpen ? "隐藏会话栏" : "显示会话栏"}
            active={sessionsOpen}
            onClick={onToggleSessions}
          >
            <PanelLeftIcon />
          </ToolbarButton>
        ) : null}
        {onToggleFilesPanel ? (
          <ToolbarButton
            title={filesPanelOpen ? "隐藏项目文件" : "显示项目文件"}
            active={filesPanelOpen}
            onClick={onToggleFilesPanel}
          >
            <PanelRightIcon />
          </ToolbarButton>
        ) : null}
      </div>
    </div>
  );
}
