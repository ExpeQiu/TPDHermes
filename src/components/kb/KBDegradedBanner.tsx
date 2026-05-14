"use client";

import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";

const STORAGE_KEY = "kb_degraded_banner_dismissed";

interface KBHealthStatus {
  status: "ok" | "degraded" | "offline";
  message?: string;
}

interface KBHealthBody {
  external_kb: string;
  cache_mode?: boolean;
  cached_entries?: number;
  readonly_mode?: boolean;
  warning?: string;
}

async function checkKBHealth(): Promise<KBHealthStatus> {
  try {
    const data = await apiGet<KBHealthBody>("/kb/health");
    const degraded =
      data.external_kb !== "up" ||
      data.readonly_mode === true ||
      Boolean(data.warning);
    if (degraded) {
      return {
        status: "degraded",
        message: data.warning || `外部知识库：${data.external_kb}`,
      };
    }
    return { status: "ok" };
  } catch {
    return { status: "offline", message: "无法连接到知识库服务" };
  }
}

/**
 * KBDegradedBanner：根据 /api/v1/kb/health 判断是否在只读/降级模式。
 */
export default function KBDegradedBanner() {
  const [health, setHealth] = useState<KBHealthStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "true") {
      setDismissed(true);
      return;
    }

    checkKBHealth().then((result) => {
      setHealth(result);
      if (result.status !== "degraded") {
        setDismissed(true);
      }
    });
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  if (dismissed || !health || health.status !== "degraded") {
    return null;
  }

  return (
    <div className="w-full bg-orange-600/20 border border-orange-500/50 rounded-lg p-4 flex items-start justify-between gap-4 mb-4">
      <div className="flex items-start gap-3">
        <span className="text-orange-400 text-xl mt-0.5">⚠️</span>
        <div>
          <p className="text-orange-300 font-medium text-sm">
            知识库当前为只读缓存模式，部分内容可能不是最新
          </p>
          {health.message && (
            <p className="text-orange-400/70 text-xs mt-1">
              {health.message}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={handleDismiss}
        className="text-orange-400 hover:text-orange-300 text-lg leading-none transition"
        aria-label="关闭提示"
      >
        ×
      </button>
    </div>
  );
}
