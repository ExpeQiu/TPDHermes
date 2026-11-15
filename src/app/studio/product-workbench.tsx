"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch, apiGet, apiPost } from "@/lib/api";

const OPERATIONS: Record<"V05" | "V10", string[]> = {
  V05: ["show", "import", "patch-link", "unlock", "revoke-support", "suggest", "task-show", "wait", "cancel", "select-value", "export"],
  V10: ["show", "import", "suggest", "task-show", "wait", "cancel", "patch-link", "revise-claim", "unlock", "revoke-evidence", "confirm-strength", "export"],
};

export function ProductWorkbench({ product, projectId, revision }: {
  product: "V05" | "V10";
  projectId: string;
  revision: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const opened = useRef(false);
  const [page, setPage] = useState("");
  const [error, setError] = useState("");
  const title = product === "V05" ? "TPCstore V05 技术价值链" : "TPCstore V10 主张与证据";

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function onMessage(event: MessageEvent) {
      const sender = frame.current?.contentWindow;
      if (!sender || event.source !== sender || event.origin !== "null") return;
      if (event.data?.product !== product) return;
      if (event.data?.type === "tpc-ready") {
        sender.postMessage({ type: "tpc-context", product, project_id: projectRef.current }, "*");
        return;
      }
      try {
        if (event.data?.type === "tpc-fixture") {
          const result = await apiGet(`/studio/apps/${product}/fixture`);
          if (active) sender.postMessage({ type: "tpc-result", product, result }, "*");
          return;
        }
        if (event.data?.type !== "tpc-operation") return;
        const input = event.data.input;
        if (!input || !OPERATIONS[product].includes(input.operation)) return;
        const result = await apiPost(`/studio/apps/${product}/workspace`, { ...input, project_id: projectRef.current });
        if (active) sender.postMessage({ type: "tpc-result", product, result }, "*");
      } catch (failure) {
        if (active) sender.postMessage({
          type: "tpc-result",
          product,
          error: failure instanceof Error ? failure.message : String(failure),
        }, "*");
      }
    }
    window.addEventListener("message", onMessage);
    void (async () => {
      try {
        const result = await apiFetch(`/studio/apps/${product}/page`, { signal: controller.signal });
        if (!result.ok) throw new Error(`无法加载 ${title}`);
        const html = await result.text();
        if (active) setPage(html);
      } catch (failure) {
        if (active && !(failure instanceof DOMException && failure.name === "AbortError")) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("message", onMessage);
    };
  }, [product, title]);

  useEffect(() => {
    if (!page) return;
    if (!opened.current) {
      opened.current = true;
      return;
    }
    frame.current?.contentWindow?.postMessage({ type: "tpc-refresh", product }, "*");
  }, [revision, page, product]);

  if (!page) return <p className="p-4" role="status">{error || `正在加载${title}…`}</p>;
  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts allow-modals"
      className="min-h-0 w-full flex-1 border-0 bg-slate-950"
      srcDoc={page}
    />
  );
}
