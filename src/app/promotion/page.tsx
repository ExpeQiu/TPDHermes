"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ProjectFilesRail } from "@/components/project-files-rail";
import { apiGet } from "@/lib/api";
import type { ProjectRecord } from "@/lib/chat-context";
import { fetchProjectFilesUnified, type ProjectFileItem } from "@/lib/co-create-api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

const WORKSPACE = "min-h-0 flex-1 overflow-y-auto bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white";
const STAGES = ["整理资料", "出品与审核", "保存导出"];

export default function PromotionChooserPage() {
  return (
    <Suspense fallback={<p className={WORKSPACE}>正在打开技术推广包…</p>}>
      <PromotionChooser />
    </Suspense>
  );
}

function PromotionChooser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preset = searchParams.get("project") || "";
  const empty = searchParams.get("empty") === "1";
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState(preset);
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    console.info("[promotion] chooser", { projectId: preset || null, empty });
  }, [preset, empty]);

  useEffect(() => {
    setProjectId(preset);
  }, [preset]);

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
      setFiles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchProjectFilesUnified(projectId)
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch((err) => {
        console.warn("[promotion] 项目文件加载失败", { projectId, err });
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  function openProject(next: string) {
    if (!next || next === projectId) return;
    console.info("[promotion] 文件栏选择项目", { from: projectId || null, to: next });
    router.push(`/projects/${next}/promotion?choose=1`);
  }

  function renderRail() {
    return (
      <ProjectFilesRail
        scope="promotion"
        autoHide
        initialOpen
        projects={projects}
        projectId={projectId}
        fileKey={null}
        files={files}
        loading={loading}
        onProjectChange={openProject}
        onFileChange={() => undefined}
        onRefresh={() => setRefreshKey((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <details open className="group shrink-0 border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>项目文件</span>
          <span className="text-xs text-slate-500 group-open:hidden">展开</span>
          <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
        </summary>
        <div className="h-[42vh] min-h-0 border-t border-slate-200 dark:border-slate-800">{renderRail()}</div>
      </details>
      <main className={WORKSPACE}>
        <div className={`${CONTENT_MAX_CLASS} space-y-6`}>
          <h1 className="text-2xl font-semibold">技术推广包</h1>
          <p className="text-sm text-slate-500">在右侧项目文件栏选择项目，再开始整理资料。</p>
          {empty ? (
            <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
              这个项目还没有资料。换一个项目，或先在项目里放入文件。
            </p>
          ) : null}
          <div role="tablist" aria-label="技术推广包" className="flex gap-4 border-b border-slate-200 dark:border-slate-700">
            {STAGES.map((title, index) => (
              <span
                key={title}
                role="tab"
                aria-selected={index === 0}
                className={`-mb-px border-b-2 px-3 py-2.5 text-sm ${index === 0 ? "border-blue-500 font-semibold" : "border-transparent text-slate-400"}`}
              >
                {title}
              </span>
            ))}
          </div>
        </div>
      </main>
      <div className="hidden h-full min-h-0 lg:flex">{renderRail()}</div>
    </div>
  );
}
