"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

type RuntimeConfig = {
  module: string;
  data_source: string;
  mock_mode: boolean;
  chat: {
    available: boolean;
    target: string | null;
    model: string;
  };
  wiki: {
    url: string;
    url_source?: string;
  };
  warnings: string[];
};

function sourceLabel(source: string | undefined): string {
  if (source === "saved") return "页面保存";
  if (source === "env") return "环境变量";
  return "默认";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-slate-200 py-3 last:border-b-0 sm:grid-cols-[8rem_1fr] dark:border-slate-800">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="break-all text-sm text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}

export default function RuntimeConfigPanel() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    apiGet<RuntimeConfig>("/system/config")
      .then((payload) => {
        if (alive) setConfig(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载运行配置失败");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <p className="mt-4 text-sm text-red-500 dark:text-red-400">{error}</p>;
  }
  if (!config) {
    return <p className="mt-4 text-sm text-slate-500">读取运行配置…</p>;
  }

  return (
    <div className="mt-4 max-w-3xl rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
      <dl>
        <Row label="数据来源" value={config.data_source === "env" ? "环境变量（尚无页面保存值）" : config.data_source} />
        <Row label="Mock" value={config.mock_mode ? "开启" : "关闭"} />
        <Row label="对话上游" value={config.chat.available ? config.chat.target || "已配置" : "未配置"} />
        <Row label="模型" value={config.chat.model} />
        <Row label="Wiki MCP" value={`${config.wiki.url}（${sourceLabel(config.wiki.url_source)}）`} />
      </dl>
      {config.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-amber-700 dark:text-amber-300">
          {config.warnings.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-slate-500">
        本页只展示当前有效值，不回显密钥。之后在此保存的 Host、模型与能力以页面记录为准，启动不会再用环境变量盖回。
      </p>
    </div>
  );
}
