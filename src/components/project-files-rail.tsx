"use client";

import { useEffect, useRef, useState } from "react";

import { ProjectFilesPanel } from "@/app/projects/[id]/co-create/components/ProjectFilesPanel";
import type { ProjectFileItem } from "@/lib/co-create-api";
import type { ProjectRecord } from "@/lib/chat-context";

type Props = {
  scope: "chat" | "studio";
  projects: ProjectRecord[];
  projectId: string;
  fileKey: string | null;
  files: ProjectFileItem[];
  loading: boolean;
  locked?: boolean;
  /** 与项目共创右侧栏相同：默认收起，悬停展开，可固定 */
  autoHide?: boolean;
  onProjectChange: (projectId: string) => void;
  onFileChange: (fileKey: string | null) => void;
  onRefresh: () => void;
};

/** 对话创作与场景创作共用的项目文件栏，交互与项目共创文件栏一致。 */
export function ProjectFilesRail({
  scope,
  projects,
  projectId,
  fileKey,
  files,
  loading,
  locked = false,
  autoHide = false,
  onProjectChange,
  onFileChange,
  onRefresh,
}: Props) {
  const [pinned, setPinned] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const open = !autoHide || pinned || revealed;

  useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, []);

  const reveal = () => {
    if (!autoHide) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setRevealed(true);
  };

  const conceal = () => {
    if (!autoHide || pinned) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setRevealed(false);
      console.info(`[${scope}] 文件栏自动隐藏`);
    }, 280);
  };

  const panel = (
    <ProjectFilesPanel
      projectId={projectId}
      boundProjectId={projectId}
      routeProjectId=""
      projects={projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
      }))}
      allowUnbound
      listAllProjects
      onBoundProjectChange={
        locked
          ? undefined
          : (next) => {
              console.info(`[${scope}] 文件栏绑定项目`, { project_id: next || null });
              onProjectChange(next);
            }
      }
      files={files}
      loading={Boolean(projectId) && loading}
      openTabKeys={fileKey ? [fileKey] : []}
      activeFileKey={fileKey}
      pinnedFileIds={[]}
      roundFileIds={[]}
      onSelectPreview={(key) => {
        if (!key || key === fileKey) {
          console.info(`[${scope}] 文件栏取消文件`, { file: key, project_id: projectId || null });
          onFileChange(null);
          return;
        }
        console.info(`[${scope}] 文件栏选择文件`, { file: key, project_id: projectId || null });
        onFileChange(key);
      }}
      onRefresh={onRefresh}
      pinLabel={autoHide ? (pinned ? "自动隐藏" : "固定") : undefined}
      onTogglePin={
        autoHide
          ? () => {
              setPinned((current) => {
                const next = !current;
                console.info(`[${scope}] 文件栏`, { pinned: next });
                return next;
              });
            }
          : undefined
      }
    />
  );

  if (!autoHide) return panel;

  return (
    <div
      className={`h-full shrink-0 overflow-hidden border-l transition-[width] duration-150 ${
        open ? "w-60 border-slate-300 dark:border-slate-700" : "w-7 border-blue-500/40"
      }`}
      onMouseEnter={reveal}
      onMouseLeave={conceal}
    >
      {open ? (
        <div className="h-full w-60">{panel}</div>
      ) : (
        <button
          type="button"
          aria-label="显示项目文件"
          onClick={() => {
            setPinned(true);
            console.info(`[${scope}] 文件栏`, { pinned: true });
          }}
          className="flex h-full w-full items-center justify-center bg-blue-500/15 text-blue-700 transition hover:bg-blue-500/25 dark:text-blue-200"
        >
          <span className="text-[10px] tracking-widest [writing-mode:vertical-rl]">项目文件</span>
        </button>
      )}
    </div>
  );
}
