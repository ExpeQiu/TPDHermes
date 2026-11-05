"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";

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

type HermesModel = {
  provider: string;
  model: string;
  base_url: string;
  config_path: string;
  config_exists: boolean;
  writable: boolean;
  key_env: string | null;
  key_configured: boolean;
  applies: string;
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

function keyStatus(model: HermesModel): string {
  if (model.key_configured) {
    return model.key_env ? `已配置（${model.key_env}）` : "已配置";
  }
  if (model.key_env) return `未配置（${model.key_env}）`;
  return "此厂商的密钥不在本页管理";
}

export default function RuntimeConfigPanel() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [hermes, setHermes] = useState<HermesModel | null>(null);
  const [provider, setProvider] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const applyHermes = useCallback((payload: HermesModel) => {
    setHermes(payload);
    setProvider(payload.provider);
    setModelName(payload.model);
    setBaseUrl(payload.base_url);
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<RuntimeConfig>("/system/config")
      .then((payload) => {
        if (alive) setConfig(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载运行配置失败");
      });
    apiGet<HermesModel>("/system/hermes-model")
      .then((payload) => {
        if (alive) applyHermes(payload);
      })
      .catch((err: unknown) => {
        if (alive) setSaveError(err instanceof Error ? err.message : "加载 Hermes 模型失败");
      });
    return () => {
      alive = false;
    };
  }, [applyHermes]);

  const saveModel = async () => {
    setSaving(true);
    setSaveError("");
    setSavedMsg("");
    try {
      applyHermes(
        await apiPut<HermesModel>("/system/hermes-model", {
          provider,
          model: modelName,
          base_url: baseUrl,
        }),
      );
      setSavedMsg("已写入 config.yaml。新会话使用该模型，进行中的对话不变。");
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "保存 Hermes 模型失败");
    } finally {
      setSaving(false);
    }
  };

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
        <Row label="调用名" value={config.chat.model} />
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
        调用名是发给 Hermes 的请求标识，保持 hermes-agent。下面的厂商和模型写入 deploy/hermes-agent/config.yaml，启动不会用环境变量盖回。
      </p>

      <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-800">
        <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">Hermes 模型</h2>
        <p className="mt-1 text-xs text-slate-500">
          默认值来自 config.yaml。保存后对新会话生效。
          {hermes ? ` 密钥：${keyStatus(hermes)}` : ""}
        </p>
        {saveError && <p className="mt-3 text-sm text-red-500 dark:text-red-400">{saveError}</p>}
        {savedMsg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{savedMsg}</p>}
        {hermes && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="text-slate-700 dark:text-slate-200">厂商</span>
              <input
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                placeholder="minimax-cn"
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-700 dark:text-slate-200">模型</span>
              <input
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                placeholder="MiniMax-M2.7-highspeed"
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-700 dark:text-slate-200">Base URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                placeholder="https://api.minimaxi.com/anthropic"
              />
            </label>
            <button
              type="button"
              disabled={!hermes.writable || saving}
              onClick={() => void saveModel()}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存 Hermes 模型"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
