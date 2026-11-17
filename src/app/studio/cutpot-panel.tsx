"use client";

import { useEffect } from "react";
import { apiPost } from "@/lib/api";

const inflight = new Map<string, Promise<{ url: string; error?: string }>>();

async function connectOnce(projectId: string): Promise<{ url: string; error?: string }> {
  try {
    const result = await apiPost<{ webUrl?: string }>("/studio/cutpot", { project_id: projectId || null, action: "connect" });
    const url = result.webUrl ?? "";
    return { url, error: url ? undefined : "CutPot 没有返回编辑器地址" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url: "", error: message };
  }
}

function connectCutpot(projectId: string): Promise<{ url: string; error?: string }> {
  const existing = inflight.get(projectId);
  if (existing) return existing;
  const task = (async () => {
    console.info("[studio]", { event: "studio.cutpot.connect", project_id: projectId });
    const first = await connectOnce(projectId);
    if (!first.error?.includes("BUSY")) return first;
    console.info("[studio]", { event: "studio.cutpot.connect_retry", project_id: projectId });
    await new Promise((resolve) => setTimeout(resolve, 700));
    return connectOnce(projectId);
  })().finally(() => {
    inflight.delete(projectId);
  });
  inflight.set(projectId, task);
  return task;
}

/** 连接本机 CutPot。未选项目时走用户工作区，选中项目后再隔离到该项目。 */
export function CutPotPanel({
  projectId,
  onUrlChange,
}: {
  projectId: string;
  onUrlChange?: (url: string, error?: string) => void;
}) {
  useEffect(() => {
    let cancelled = false;
    void connectCutpot(projectId).then((result) => {
      if (cancelled) return;
      if (result.error) console.warn("[studio]", { event: "studio.cutpot.connect_failed", project_id: projectId, error: result.error });
      onUrlChange?.(result.url, result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [onUrlChange, projectId]);

  return null;
}
