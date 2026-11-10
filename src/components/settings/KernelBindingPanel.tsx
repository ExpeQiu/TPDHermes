"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGetWithTimeout, apiPost, apiPut } from "@/lib/api";

type KernelModel = {
  config_path: string | null;
  config_exists: boolean;
  writable: boolean;
  provider: string;
  model: string;
  base_url: string;
  key_env: string | null;
  key_configured: boolean;
  key_writable: boolean;
  fields: string[];
};

type KernelInstall = {
  root: string;
  command: string | null;
  version: string | null;
  evidence: string[];
  bound: boolean;
  model: KernelModel;
};

type KernelPlatform = {
  id: string;
  label: string;
  installs: KernelInstall[];
};

type KernelSnapshot = {
  bound: { kernel_id: string; root: string; present: boolean; label: string } | null;
  platforms: KernelPlatform[];
};

type ProbeResult = {
  ok: boolean;
  reachable?: boolean;
  latency_ms?: number;
  message: string;
};

const EVIDENCE_LABEL: Record<string, string> = {
  home: "安装目录",
  command: "命令",
  scan: "目录扫描",
};

function evidenceText(evidence: string[]): string {
  return evidence.map((item) => EVIDENCE_LABEL[item] || item).join("、");
}

function modelSummary(model: KernelModel): string {
  if (!model.config_exists) return "没有模型配置文件";
  const parts = [model.provider, model.model, model.base_url].filter(Boolean);
  return parts.join(" · ") || "配置里没有模型";
}

function keyStatus(model: KernelModel): string {
  if (!model.config_exists) return "";
  if (!model.key_writable) return model.key_configured ? "密钥在该内核的登录态里，此页不改。" : "此页不管理该内核的密钥。";
  if (model.key_configured) {
    const name = model.key_env ? `（${model.key_env}）` : "";
    return `密钥已配置${name}。留空则不修改。`;
  }
  if (model.key_env) return `密钥未配置（${model.key_env}）。留空则不写入。`;
  return "此厂商的密钥不在本页管理。";
}

export default function KernelBindingPanel() {
  const [snapshot, setSnapshot] = useState<KernelSnapshot | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [provider, setProvider] = useState("");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      setSnapshot(await apiGetWithTimeout<KernelSnapshot>("/system/kernels", 20000));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "识别本机内核失败");
    }
  }, []);

  const boundInstall =
    snapshot?.platforms.flatMap((platform) => platform.installs).find((install) => install.bound) ?? null;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!boundInstall) return;
    setProvider(boundInstall.model.provider);
    setModelName(boundInstall.model.model);
    setBaseUrl(boundInstall.model.base_url);
    setApiKey("");
    setSavedMsg("");
    setSaveError("");
    setProbe(null);
  }, [boundInstall]);

  const bind = async (kernelId: string, root: string) => {
    setPending(root);
    setError("");
    try {
      setSnapshot(await apiPut<KernelSnapshot>("/system/kernels/binding", { kernel_id: kernelId, root }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "绑定内核失败");
    } finally {
      setPending("");
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    setSaveError("");
    try {
      setProbe(
        await apiPost<ProbeResult>("/system/kernels/model/probe", {
          provider,
          model: modelName,
          base_url: baseUrl,
          api_key: apiKey,
        }),
      );
    } catch (err: unknown) {
      setProbe({ ok: false, message: err instanceof Error ? err.message : "探测失败" });
    } finally {
      setProbing(false);
    }
  };

  const saveModel = async () => {
    setSaving(true);
    setSaveError("");
    setSavedMsg("");
    try {
      setSnapshot(
        await apiPut<KernelSnapshot>("/system/kernels/model", {
          provider,
          model: modelName,
          base_url: baseUrl,
          api_key: apiKey,
        }),
      );
      setApiKey("");
      setSavedMsg("已写入当前绑定内核的配置文件。");
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "保存内核模型失败");
    } finally {
      setSaving(false);
    }
  };

  const unbind = async () => {
    setPending("unbind");
    setError("");
    try {
      setSnapshot(await apiDelete<KernelSnapshot>("/system/kernels/binding"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "解除绑定失败");
    } finally {
      setPending("");
    }
  };

  return (
    <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">内核绑定</h2>
          <p className="mt-1 text-xs text-slate-500">
            识别本机已安装的智能体平台，例如 hermes-agent、deepseek-harness、codex-harness。绑定只记在本机配置，不改环境变量。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
        >
          重新识别
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-500 dark:text-red-400">{error}</p>}
      {snapshot?.bound && !snapshot.bound.present && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          已绑定的 {snapshot.bound.label} 这次没有识别到。
          <button type="button" className="ml-2 underline" onClick={() => void unbind()}>
            解除绑定
          </button>
        </p>
      )}
      {!snapshot && !error && <p className="mt-4 text-sm text-slate-500">正在识别本机内核…</p>}
      {snapshot && (
        <ul className="mt-4 space-y-3">
          {snapshot.platforms.map((platform) => (
            <li
              key={platform.id}
              className="rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-800"
            >
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{platform.label}</p>
              {platform.installs.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">未发现安装</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {platform.installs.map((install) => (
                    <li key={install.root} className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-all font-mono text-xs text-slate-700 dark:text-slate-200">{install.root}</p>
                        <p className="mt-0.5 text-xs text-slate-800 dark:text-slate-200">{modelSummary(install.model)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {install.version ? `${install.version} · ` : ""}
                          {evidenceText(install.evidence)}
                          {install.model.config_path ? ` · ${install.model.config_path}` : ""}
                        </p>
                      </div>
                      {install.bound ? (
                        <button
                          type="button"
                          disabled={pending !== ""}
                          onClick={() => void unbind()}
                          className="rounded-lg border border-emerald-600 px-3 py-1.5 text-sm text-emerald-700 dark:text-emerald-300"
                        >
                          {pending === "unbind" ? "解除中…" : "已绑定"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={pending !== ""}
                          onClick={() => void bind(platform.id, install.root)}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                          {pending === install.root ? "绑定中…" : "绑定"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 border-t border-slate-200 pt-6 dark:border-slate-800">
        <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">内核模型</h2>
        {!boundInstall ? (
          <p className="mt-1 text-xs text-slate-500">先绑定上面的一个安装。这里只显示并保存那一份配置，不会改其他内核。</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              当前绑定 {snapshot?.bound?.label}。数值来自 {boundInstall.model.config_path || "该安装"}。
              {keyStatus(boundInstall.model) ? ` ${keyStatus(boundInstall.model)}` : ""}
            </p>
            {saveError && <p className="mt-3 text-sm text-red-500 dark:text-red-400">{saveError}</p>}
            {savedMsg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{savedMsg}</p>}
            {!boundInstall.model.config_exists ? (
              <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">这份安装没有模型配置文件。</p>
            ) : (
              <div className="mt-4 space-y-3">
                {boundInstall.model.fields.includes("provider") && (
                  <label className="block text-sm">
                    <span className="text-slate-700 dark:text-slate-200">厂商</span>
                    <input
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                )}
                <label className="block text-sm">
                  <span className="text-slate-700 dark:text-slate-200">模型</span>
                  <input
                    value={modelName}
                    onChange={(event) => setModelName(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  />
                </label>
                {boundInstall.model.fields.includes("api_key") && (
                  <label className="block text-sm">
                    <span className="text-slate-700 dark:text-slate-200">密钥</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="留空则不修改现有密钥"
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                )}
                {boundInstall.model.fields.includes("base_url") && (
                  <label className="block text-sm">
                    <span className="text-slate-700 dark:text-slate-200">Base URL</span>
                    <input
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    />
                  </label>
                )}
                {probe && (
                  <p className={`text-sm ${probe.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                    探测：{probe.message}
                    {typeof probe.latency_ms === "number" ? ` · ${probe.latency_ms}ms` : ""}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={probing || saving || !modelName.trim()}
                    onClick={() => void runProbe()}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:border-slate-400 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
                  >
                    {probing ? "测试中…" : "测试连通性"}
                  </button>
                  <button
                    type="button"
                    disabled={!boundInstall.model.writable || saving || probing}
                    onClick={() => void saveModel()}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {saving ? "保存中…" : "保存到当前内核"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
