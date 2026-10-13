"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type CliAction = {
  id: string;
  label: string;
  enabled: boolean;
  command: string;
};

type CliModule = {
  id: string;
  label: string;
  command: string;
  default_key: string | null;
  actions: CliAction[];
  enabled: boolean;
  demo: boolean | null;
  defaults: Record<string, string>;
};

type CliConfig = {
  data_source: string;
  api_base: string | null;
  api_base_source: string;
  user_id: string | null;
  user_id_source: string;
  token_set: boolean;
  token_source: string;
  modules: CliModule[];
};

type TokenVerifyResult = {
  ok: boolean;
  reason: string | null;
  source: string | null;
  can_execute: boolean;
};

const DEFAULT_LABEL: Record<string, string> = {
  project: "默认项目 ID",
  collection: "默认集合",
  skill: "默认技能名",
};

export default function CliCapabilitiesPanel() {
  const [config, setConfig] = useState<CliConfig | null>(null);
  const [apiBase, setApiBase] = useState("");
  const [userId, setUserId] = useState("");
  const [token, setToken] = useState("");
  const [tokenCheck, setTokenCheck] = useState<TokenVerifyResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [modules, setModules] = useState<CliModule[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((payload: CliConfig) => {
    setConfig(payload);
    setApiBase(payload.api_base_source === "saved" ? payload.api_base || "" : "");
    setUserId(payload.user_id_source === "saved" ? payload.user_id || "" : "");
    setToken("");
    setModules(payload.modules);
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<CliConfig>("/system/cli")
      .then((payload) => {
        if (alive) apply(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载 CLI 配置失败");
      });
    return () => {
      alive = false;
    };
  }, [apply]);

  const updateModule = (id: string, patch: Partial<CliModule>) => {
    setSaved(false);
    setModules((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const verifyToken = async () => {
    setChecking(true);
    setError("");
    setTokenCheck(null);
    try {
      const result = await apiPost<TokenVerifyResult>(
        "/system/cli/token/verify",
        token.trim() ? { token: token.trim() } : {},
      );
      setTokenCheck(result);
      if (!result.ok) setError(result.reason || "Token 校验失败");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Token 校验失败");
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const typedToken = token.trim();
      if (typedToken) {
        const checked = await apiPost<TokenVerifyResult>("/system/cli/token/verify", { token: typedToken });
        setTokenCheck(checked);
        if (!checked.ok) {
          setError(checked.reason || "Token 校验失败");
          return;
        }
      }
      const payload = await apiPut<CliConfig>("/system/cli", {
        api_base: apiBase.trim() || null,
        user_id: userId.trim() || null,
        ...(typedToken ? { token: typedToken } : {}),
        modules: Object.fromEntries(
          modules.map((row) => [
            row.id,
            {
              enabled: row.enabled,
              demo: row.demo,
              defaults: row.default_key
                ? { [row.default_key]: row.defaults[row.default_key] || "" }
                : {},
              actions: Object.fromEntries(row.actions.map((action) => [action.id, action.enabled])),
            },
          ]),
        ),
      });
      apply(payload);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (error && !config) {
    return <p className="mt-4 text-sm text-red-500 dark:text-red-400">{error}</p>;
  }
  if (!config) {
    return <p className="mt-4 text-sm text-slate-500">读取工作台 CLI…</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid max-w-3xl gap-4 rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-slate-500">API 地址</span>
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            value={apiBase}
            placeholder={config.api_base || "http://127.0.0.1:8000"}
            onChange={(event) => {
              setSaved(false);
              setApiBase(event.target.value);
            }}
          />
          <span className="mt-1 block text-xs text-slate-500">
            当前来源：{config.api_base_source === "saved" ? "页面" : config.api_base_source === "env" ? "环境变量" : "默认"}
            {config.api_base ? ` · ${config.api_base}` : ""}
          </span>
        </label>
        <label className="block text-sm">
          <span className="text-slate-500">User ID</span>
          <input
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            value={userId}
            placeholder={config.user_id || "留空则使用 HERMES_USER_ID"}
            onChange={(event) => {
              setSaved(false);
              setUserId(event.target.value);
            }}
          />
          <span className="mt-1 block text-xs text-slate-500">
            当前来源：{config.user_id_source === "saved" ? "页面" : config.user_id_source === "env" ? "环境变量" : "未设置"}
          </span>
        </label>
        <div className="sm:col-span-2">
          <label className="block text-sm">
            <span className="text-slate-500">Agent 接入 Token</span>
            <div className="mt-1 flex gap-2">
              <input
                type="password"
                autoComplete="off"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                value={token}
                placeholder={config.token_set ? "已保存，留空则不修改" : "至少 16 位"}
                onChange={(event) => {
                  setSaved(false);
                  setTokenCheck(null);
                  setToken(event.target.value);
                }}
              />
              <button
                type="button"
                onClick={() => void verifyToken()}
                disabled={checking}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-800"
              >
                {checking ? "校验中…" : "校验"}
              </button>
            </div>
          </label>
          <p className="mt-1 text-xs text-slate-500">
            其他 Agent 凭此 Token 通过 CLI 连接本系统，并执行下方已开放的指令。当前来源：
            {config.token_source === "saved" ? "页面" : config.token_source === "env" ? "环境变量" : "未设置"}
            {tokenCheck?.ok
              ? tokenCheck.can_execute
                ? " · 校验通过，可连接并执行已开放指令"
                : ` · ${tokenCheck.reason || "校验通过，保存后即可通过 CLI 执行指令"}`
              : ""}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/50">
        <table className="min-w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">工作台</th>
              <th className="px-4 py-3 font-medium">子功能</th>
              <th className="px-4 py-3 font-medium">启用</th>
              <th className="px-4 py-3 font-medium">演示数据</th>
              <th className="px-4 py-3 font-medium">默认参数</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((row) => (
              <tr key={row.id} className="border-t border-slate-200 dark:border-slate-800">
                <td className="px-4 py-3 text-slate-900 dark:text-slate-100">{row.label}</td>
                <td className="px-4 py-3">
                  <div className="flex max-w-xl flex-wrap gap-2">
                    {row.actions.map((action) => (
                      <label key={action.id} className="inline-flex items-center gap-1 text-xs text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={action.enabled}
                          aria-label={`${row.label} ${action.label}`}
                          disabled={!row.enabled}
                          onChange={(event) =>
                            updateModule(row.id, {
                              actions: row.actions.map((item) =>
                                item.id === action.id ? { ...item, enabled: event.target.checked } : item,
                              ),
                            })
                          }
                        />
                        {action.label}
                      </label>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    aria-label={`${row.label} 启用`}
                    onChange={(event) => updateModule(row.id, { enabled: event.target.checked })}
                  />
                </td>
                <td className="px-4 py-3">
                  <select
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                    aria-label={`${row.label} 演示数据`}
                    value={row.demo === null ? "inherit" : row.demo ? "on" : "off"}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateModule(row.id, {
                        demo: value === "inherit" ? null : value === "on",
                      });
                    }}
                  >
                    <option value="inherit">跟随全局</option>
                    <option value="on">强制演示</option>
                    <option value="off">强制在线</option>
                  </select>
                </td>
                <td className="px-4 py-3">
                  {row.default_key ? (
                    <input
                      className="w-full min-w-40 rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                      aria-label={`${row.label} ${DEFAULT_LABEL[row.default_key] || "默认值"}`}
                      placeholder={DEFAULT_LABEL[row.default_key] || row.default_key}
                      value={row.defaults[row.default_key] || ""}
                      onChange={(event) =>
                        updateModule(row.id, {
                          defaults: { ...row.defaults, [row.default_key as string]: event.target.value },
                        })
                      }
                    />
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
      >
        {saving ? "保存中…" : saved ? "已保存" : "保存 CLI 配置"}
      </button>
      <p className="text-xs text-slate-500">
        关闭后对应命令会拒绝执行。页面里写成 false 的开关不会在启动时被环境变量打开。留空的 API 地址和 User ID 才回落到环境变量。
      </p>
    </div>
  );
}
