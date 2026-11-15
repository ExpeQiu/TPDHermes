"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, apiPost } from "@/lib/api";

export function V04Workbench({ projectId, fileId, fileKind, revision, focus }: {
  projectId: string;
  fileId: string;
  revision: number;
  focus?: { card_id: string; field?: string; receipt: string };
  fileKind: "attachment" | "output";
}) {
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const frame = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function onMessage(event: MessageEvent) {
      const sender = frame.current?.contentWindow;
      if (!sender || event.source !== sender || event.origin !== "null") return;
      if (event.data?.type === "v04-ready") {
        sender.postMessage({ type: "v04-refresh", focus: focusRef.current }, "*");
        return;
      }
      if (event.data?.type !== "v04-operation") return;
      const input = event.data.input;
      if (!input || !["show", "extract", "save", "check", "export", "task-show", "reconcile"].includes(input.operation)) return;
      try {
        const result = await apiPost("/studio/workbench", {
          ...input,
          project_id: projectId,
          file_id: fileId,
          file_kind: fileKind,
        });
        if (active) sender.postMessage({ type: "v04-result", result }, "*");
      } catch (failure) {
        if (active) sender.postMessage({
          type: "v04-result",
          error: failure instanceof Error ? failure.message : String(failure),
        }, "*");
      }
    }
    window.addEventListener("message", onMessage);
    void (async () => {
      try {
        const result = await apiFetch("/studio/workbench/page", { signal: controller.signal });
        if (!result.ok) throw new Error("无法加载 TPCstore 技术卡工作台");
        const html = await result.text();
        if (active) setPage(html);
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("message", onMessage);
    };
  }, [projectId, fileId, fileKind]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: "v04-refresh", focus }, "*");
  }, [revision, focus, page]);

  if (!page) return <p className="p-4" role="status">{error || "正在加载技术卡工作台…"}</p>;
  return (
    <iframe
      ref={frame}
      title="TPCstore V04 技术卡工作台"
      sandbox="allow-scripts allow-modals"
      className="min-h-0 w-full flex-1 border-0"
      srcDoc={page}
    />
  );
}
