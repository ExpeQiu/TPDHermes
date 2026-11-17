"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { WorkbenchBoot } from "./workbench-boot";

type LocalStatus = {
  name: string;
  url: string;
  ready: boolean;
  phase?: string;
  progress?: number;
  message?: string;
};

/** 点击技能卡后请求后台启动，进度完成再嵌入本机工作台。 */
export function LocalAppFrame({ product }: { product: "V14" | "V18" | "V22" }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const boot = useCallback((mode: "start" | "status") => {
    const request = mode === "start"
      ? apiPost<LocalStatus>(`/studio/local-apps/${product}/start`, {})
      : apiGet<LocalStatus>(`/studio/local-apps/${product}`);
    return request.then((result) => {
      console.info("[studio]", {
        event: "studio.local_app",
        product,
        phase: result.phase,
        progress: result.progress,
        ready: result.ready,
      });
      return result;
    });
  }, [product]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const run = (mode: "start" | "status") => {
      boot(mode)
        .then((result) => {
          if (!alive) return;
          setStatus(result);
          setError("");
          if (!result.ready && result.phase !== "failed") {
            timer = window.setTimeout(() => run("status"), 800);
          }
        })
        .catch((failure: unknown) => {
          if (!alive) return;
          const message = failure instanceof Error ? failure.message : String(failure);
          setError(message === "Not Found" ? "启动接口还没有就绪，请重启场景创作服务后再打开这张技能卡。" : message);
        });
    };
    run("start");
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [boot, attempt]);

  if (!status?.ready) {
    return (
      <WorkbenchBoot
        title={status?.name ? `正在打开 ${status.name}` : "正在打开工作台"}
        progress={status?.progress ?? 8}
        message={error || status?.message}
        failed={status?.phase === "failed" || Boolean(error)}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  return (
    <iframe
      title={status.name}
      src={status.url}
      className="min-h-0 w-full flex-1 border-0 bg-slate-950"
      onLoad={() => console.info("[studio]", { event: "studio.local_app.embed", product, url: status.url })}
    />
  );
}
