"use client";

import { useState, useEffect } from "react";

// localStorage key，用于记录用户是否已关闭 Banner
const STORAGE_KEY = "kb_degraded_banner_dismissed";

interface KBHealthStatus {
  status: "ok" | "degraded" | "offline";
  message?: string;
}

async function checkKBHealth(): Promise<KBHealthStatus> {
  try {
    const res = await fetch("/api/kb/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // 网络错误降级为 offline
    return { status: "offline", message: "无法连接到知识库服务" };
  }
}

/**
 * KBDegradedBanner
 * - 检查知识库健康状态
 * - 若为 degraded，显示橙色警告 Banner
 * - 用户可关闭，关闭后记录到 localStorage，不再显示
 */
export default function KBDegradedBanner() {
  const [health, setHealth] = useState<KBHealthStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // 若用户之前已关闭，不再检查
    if (localStorage.getItem(STORAGE_KEY) === "true") {
      setDismissed(true);
      return;
    }

    checkKBHealth().then((result) => {
      setHealth(result);
      // 只有 degraded 状态才显示 Banner
      if (result.status !== "degraded") {
        setDismissed(true);
      }
    });
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  // 不满足显示条件时返回 null
  if (dismissed || !health || health.status !== "degraded") {
    return null;
  }

  return (
    <div className="w-full bg-orange-600/20 border border-orange-500/50 rounded-lg p-4 flex items-start justify-between gap-4 mb-4">
      <div className="flex items-start gap-3">
        {/* 警告图标 */}
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

      {/* 关闭按钮 */}
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
