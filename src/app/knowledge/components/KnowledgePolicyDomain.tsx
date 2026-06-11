"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { apiGet, apiPost, apiPut } from "@/lib/api";

type PolicyStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "published"
  | "offline"
  | "rejected";

interface KnowledgePolicyItem {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  config: Record<string, unknown>;
  version: string;
  status: PolicyStatus;
  created_by?: string | null;
  approved_by?: string | null;
  published_by?: string | null;
  offlined_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  approved_at?: string | null;
  published_at?: string | null;
  offlined_at?: string | null;
}

interface KnowledgePolicyVersionItem {
  id: string;
  policy_id: string;
  version: string;
  status: PolicyStatus;
  change_note?: string | null;
  created_by?: string | null;
  created_at?: string | null;
}

interface ProjectBindingItem {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  knowledge_policy_id?: string | null;
}

interface ScenarioBindingItem {
  id: string;
  code: string;
  name: string;
  category?: string | null;
  status?: string | null;
  knowledge_policy_id?: string | null;
}

const STATUS_LABELS: Record<PolicyStatus, string> = {
  draft: "草稿",
  pending_approval: "待审批",
  approved: "已审批",
  published: "已发布",
  offline: "已下线",
  rejected: "已驳回",
};

const STATUS_BADGE: Record<PolicyStatus, string> = {
  draft:
    "bg-slate-100 text-slate-800 border border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600",
  pending_approval:
    "bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-500/20 dark:text-amber-100 dark:border-amber-500/30",
  approved:
    "bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-500/20 dark:text-blue-100 dark:border-blue-500/30",
  published:
    "bg-emerald-100 text-emerald-900 border border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-100 dark:border-emerald-500/30",
  offline:
    "bg-rose-100 text-rose-900 border border-rose-300 dark:bg-rose-500/20 dark:text-rose-100 dark:border-rose-500/30",
  rejected:
    "bg-rose-100 text-rose-900 border border-rose-300 dark:bg-rose-500/20 dark:text-rose-100 dark:border-rose-500/30",
};

const CONFIG_TEMPLATE = `{
  "mode": "restricted",
  "collections": ["public.structured_tech.topic"],
  "project_bound": true,
  "top_k": 5,
  "fallback_policy": "cache_allowed",
  "eligible_domains": ["structured_tech"],
  "write_control": {
    "allowed_collections": ["public.structured_tech.topic"]
  }
}`;

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

function parseConfigText(text: string): Record<string, unknown> {
  const raw = text.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("策略配置必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export default function KnowledgePolicyDomain({ active }: { active: boolean }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PolicyStatus | "all">("all");
  const [items, setItems] = useState<KnowledgePolicyItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgePolicyItem | null>(null);
  const [versions, setVersions] = useState<KnowledgePolicyVersionItem[]>([]);
  const [createCode, setCreateCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createConfigText, setCreateConfigText] = useState(CONFIG_TEMPLATE);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editConfigText, setEditConfigText] = useState(CONFIG_TEMPLATE);
  const [projects, setProjects] = useState<ProjectBindingItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioBindingItem[]>([]);
  const [bindingBusy, setBindingBusy] = useState(false);

  const loadList = useCallback(
    async (preferredId?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const query = statusFilter === "all" ? "" : `?status=${encodeURIComponent(statusFilter)}`;
        const data = await apiGet<{ items: KnowledgePolicyItem[] }>(`/kb/policies/${query}`);
        const rows = data.items || [];
        setItems(rows);
        const nextId =
          preferredId && rows.some((item) => item.id === preferredId)
            ? preferredId
            : rows[0]?.id ?? null;
        setSelectedId(nextId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "策略列表加载失败");
        setItems([]);
        setSelectedId(null);
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  const loadDetail = useCallback(async (policyId: string) => {
    setLoading(true);
    setError(null);
    try {
      const [policy, versionData] = await Promise.all([
        apiGet<KnowledgePolicyItem>(`/kb/policies/${encodeURIComponent(policyId)}`),
        apiGet<{ items: KnowledgePolicyVersionItem[] }>(
          `/kb/policies/${encodeURIComponent(policyId)}/versions`,
        ),
      ]);
      setDetail(policy);
      setVersions(versionData.items || []);
      setEditName(policy.name || "");
      setEditDescription(policy.description || "");
      setEditConfigText(JSON.stringify(policy.config || {}, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "策略详情加载失败");
      setDetail(null);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBindings = useCallback(async () => {
    try {
      const [projectRows, scenarioRows] = await Promise.all([
        apiGet<ProjectBindingItem[]>("/projects/"),
        apiGet<ScenarioBindingItem[]>("/scenarios/"),
      ]);
      setProjects(projectRows || []);
      setScenarios(scenarioRows || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "绑定数据加载失败");
      setProjects([]);
      setScenarios([]);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadList(selectedId);
    void loadBindings();
  }, [active, loadBindings, loadList, statusFilter]);

  useEffect(() => {
    if (!active || !selectedId) return;
    void loadDetail(selectedId);
  }, [active, selectedId, loadDetail]);

  const allowedCollections = useMemo(() => {
    const writeControl = detail?.config?.write_control;
    if (!writeControl || typeof writeControl !== "object" || Array.isArray(writeControl)) {
      return [];
    }
    const raw = (writeControl as { allowed_collections?: unknown }).allowed_collections;
    return Array.isArray(raw) ? raw.map(String) : [];
  }, [detail]);

  const resetCreateForm = () => {
    setCreateCode("");
    setCreateName("");
    setCreateDescription("");
    setCreateConfigText(CONFIG_TEMPLATE);
  };

  const refreshAfterBinding = async () => {
    await loadBindings();
    if (detail?.id) {
      await loadDetail(detail.id);
    }
  };

  const createPolicy = async () => {
    if (!createCode.trim() || !createName.trim()) {
      setError("请填写策略编码和策略名称");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const config = parseConfigText(createConfigText);
      const created = await apiPost<KnowledgePolicyItem>("/kb/policies/", {
        code: createCode.trim(),
        name: createName.trim(),
        description: createDescription.trim() || null,
        config,
        change_note: "created_from_policy_console",
      });
      resetCreateForm();
      setMessage(`已创建策略：${created.name}`);
      await loadList(created.id);
      await loadDetail(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建策略失败");
    } finally {
      setSaving(false);
    }
  };

  const savePolicy = async () => {
    if (!detail) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const config = parseConfigText(editConfigText);
      const saved = await apiPut<KnowledgePolicyItem>(`/kb/policies/${encodeURIComponent(detail.id)}`, {
        name: editName.trim(),
        description: editDescription.trim() || null,
        config,
        change_note: "edited_in_policy_console",
      });
      setMessage(`已保存策略：${saved.name}`);
      await loadList(saved.id);
      await loadDetail(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存策略失败");
    } finally {
      setSaving(false);
    }
  };

  const transition = async (
    action: "submit" | "approve" | "publish" | "offline",
    successLabel: string,
  ) => {
    if (!detail) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const row = await apiPost<KnowledgePolicyItem>(
        `/kb/policies/${encodeURIComponent(detail.id)}/${action}`,
        {},
      );
      setMessage(successLabel);
      await loadList(row.id);
      await loadDetail(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "策略状态变更失败");
    } finally {
      setSaving(false);
    }
  };

  const bindProject = async (project: ProjectBindingItem, nextPolicyId: string | null) => {
    setBindingBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiPut(`/projects/${encodeURIComponent(project.id)}`, {
        knowledge_policy_id: nextPolicyId,
      });
      setMessage(
        nextPolicyId
          ? `项目「${project.name}」已绑定当前策略`
          : `项目「${project.name}」已清空策略绑定`,
      );
      await refreshAfterBinding();
    } catch (e) {
      setError(e instanceof Error ? e.message : "项目策略绑定失败");
    } finally {
      setBindingBusy(false);
    }
  };

  const bindScenario = async (scenario: ScenarioBindingItem, nextPolicyId: string | null) => {
    setBindingBusy(true);
    setError(null);
    setMessage(null);
    try {
      await apiPut(`/scenarios/${encodeURIComponent(scenario.id)}`, {
        knowledge_policy_id: nextPolicyId,
      });
      setMessage(
        nextPolicyId
          ? `场景「${scenario.name}」已绑定当前策略`
          : `场景「${scenario.name}」已清空策略绑定`,
      );
      await refreshAfterBinding();
    } catch (e) {
      setError(e instanceof Error ? e.message : "场景策略绑定失败");
    } finally {
      setBindingBusy(false);
    }
  };

  const boundProjects = useMemo(
    () => projects.filter((item) => item.knowledge_policy_id === detail?.id),
    [detail?.id, projects],
  );
  const boundScenarios = useMemo(
    () => scenarios.filter((item) => item.knowledge_policy_id === detail?.id),
    [detail?.id, scenarios],
  );

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-violet-300/70 dark:border-violet-500/30 bg-violet-50/80 dark:bg-violet-950/20 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Policy 管理台</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              统一管理知识策略实体、版本快照和审批发布状态；项目与场景可绑定 `knowledge_policy_id`。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadList(selectedId)}
              disabled={loading}
              className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              刷新策略
            </button>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as PolicyStatus | "all")}
              className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200"
            >
              <option value="all">全部状态</option>
              <option value="draft">草稿</option>
              <option value="pending_approval">待审批</option>
              <option value="approved">已审批</option>
              <option value="published">已发布</option>
              <option value="offline">已下线</option>
            </select>
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 p-3 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">新建策略</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-500">策略编码</span>
                <input
                  value={createCode}
                  onChange={(e) => setCreateCode(e.target.value)}
                  placeholder="如：kb-public-restricted"
                  className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-500">策略名称</span>
                <input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="如：公共知识受限检索"
                  className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="text-slate-500">说明</span>
                <input
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="补充约束、适用对象与发布意图"
                  className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="text-slate-500">策略配置 JSON</span>
                <textarea
                  value={createConfigText}
                  onChange={(e) => setCreateConfigText(e.target.value)}
                  rows={11}
                  className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm font-mono"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void createPolicy()}
              disabled={saving}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
            >
              {saving ? "提交中…" : "创建策略"}
            </button>
          </div>
          <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">配置提示</p>
            <ul className="mt-2 space-y-2 text-sm text-slate-700 dark:text-slate-300">
              <li>`collections` 控制检索可见范围。</li>
              <li>`write_control.allowed_collections` 控制知识收割/写入白名单。</li>
              <li>`project_bound` 与 `eligible_domains` 可作为编排侧附加约束。</li>
              <li>项目与场景绑定后，服务端会优先读取实体策略而不是环境变量。</li>
            </ul>
          </div>
        </div>
      </div>

      {message ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(300px,0.9fr)_minmax(0,1.3fr)]">
        <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/70 dark:bg-slate-900/40 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-white">策略列表</p>
              <p className="text-xs text-slate-500">当前 {items.length} 条</p>
            </div>
            {loading ? <span className="text-xs text-slate-500">加载中…</span> : null}
          </div>
          <div className="space-y-2 max-h-[70vh] overflow-auto">
            {items.length === 0 ? (
              <p className="text-sm text-slate-500">暂无策略，可在上方直接创建。</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    selectedId === item.id
                      ? "border-violet-500 bg-violet-50 dark:bg-violet-500/10"
                      : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 hover:bg-slate-50 dark:hover:bg-slate-900"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900 dark:text-white">{item.name}</p>
                      <p className="mt-1 truncate text-xs font-mono text-slate-500">{item.code}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS_BADGE[item.status]}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>v{item.version}</span>
                    <span>{formatTime(item.updated_at)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-100/70 dark:bg-slate-900/40 p-4">
          {!detail ? (
            <div className="flex min-h-[24rem] items-center justify-center text-sm text-slate-500">
              选择一个策略查看详情、版本轨迹与治理动作。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-semibold text-slate-900 dark:text-white">{detail.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[detail.status]}`}>
                      {STATUS_LABELS[detail.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-mono text-slate-500">{detail.code}</p>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                    {detail.description || "暂无说明"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyText(detail.id).then(() => setMessage("已复制策略 ID"))}
                    className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200"
                  >
                    复制 ID
                  </button>
                  <button
                    type="button"
                    onClick={() => void transition("submit", "已提交审批")}
                    disabled={saving || detail.status !== "draft"}
                    className="rounded-lg border border-amber-400/70 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-100 disabled:opacity-40"
                  >
                    提交审批
                  </button>
                  <button
                    type="button"
                    onClick={() => void transition("approve", "已审批通过")}
                    disabled={saving || detail.status !== "pending_approval"}
                    className="rounded-lg border border-blue-400/70 px-3 py-1.5 text-xs text-blue-900 dark:text-blue-100 disabled:opacity-40"
                  >
                    审批通过
                  </button>
                  <button
                    type="button"
                    onClick={() => void transition("publish", "已发布策略")}
                    disabled={saving || detail.status !== "approved"}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                  >
                    发布
                  </button>
                  <button
                    type="button"
                    onClick={() => void transition("offline", "已下线策略")}
                    disabled={saving || !["draft", "approved", "published"].includes(detail.status)}
                    className="rounded-lg border border-rose-400/70 px-3 py-1.5 text-xs text-rose-900 dark:text-rose-100 disabled:opacity-40"
                  >
                    下线
                  </button>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">当前版本</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">v{detail.version}</p>
                </div>
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">允许写入集合</p>
                  <p className="mt-1 text-sm text-slate-900 dark:text-white">{allowedCollections.length}</p>
                </div>
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">创建时间</p>
                  <p className="mt-1 text-sm text-slate-900 dark:text-white">{formatTime(detail.created_at)}</p>
                </div>
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">最后更新时间</p>
                  <p className="mt-1 text-sm text-slate-900 dark:text-white">{formatTime(detail.updated_at)}</p>
                </div>
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">已绑定项目</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                    {boundProjects.length}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-3">
                  <p className="text-xs text-slate-500">已绑定场景</p>
                  <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                    {boundScenarios.length}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900 dark:text-white">项目 / 场景绑定</p>
                    <p className="text-xs text-slate-500">
                      直接把当前策略绑定到项目或场景，形成从创建、治理到使用的完整闭环。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadBindings()}
                    disabled={bindingBusy}
                    className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-40"
                  >
                    刷新绑定列表
                  </button>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">项目绑定</p>
                    <div className="space-y-2 max-h-72 overflow-auto">
                      {projects.map((project) => {
                        const isCurrent = project.knowledge_policy_id === detail.id;
                        return (
                          <div
                            key={project.id}
                            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-medium text-slate-900 dark:text-white">
                                  {project.name}
                                </p>
                                <p className="mt-1 truncate text-[11px] text-slate-500">
                                  {project.description || project.id}
                                </p>
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] ${
                                  isCurrent
                                    ? "bg-violet-100 text-violet-900 border border-violet-300 dark:bg-violet-500/20 dark:text-violet-100 dark:border-violet-500/30"
                                    : "bg-slate-100 text-slate-700 border border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600"
                                }`}
                              >
                                {isCurrent ? "当前策略" : project.knowledge_policy_id ? "已绑定其他策略" : "未绑定"}
                              </span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={bindingBusy || isCurrent}
                                onClick={() => void bindProject(project, detail.id)}
                                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                              >
                                绑定当前策略
                              </button>
                              <button
                                type="button"
                                disabled={bindingBusy || !project.knowledge_policy_id}
                                onClick={() => void bindProject(project, null)}
                                className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-40"
                              >
                                清空绑定
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">场景绑定</p>
                    <div className="space-y-2 max-h-72 overflow-auto">
                      {scenarios.map((scenario) => {
                        const isCurrent = scenario.knowledge_policy_id === detail.id;
                        return (
                          <div
                            key={scenario.id}
                            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate font-medium text-slate-900 dark:text-white">
                                  {scenario.name}
                                </p>
                                <p className="mt-1 truncate text-[11px] text-slate-500">
                                  {scenario.code}
                                  {scenario.category ? ` · ${scenario.category}` : ""}
                                </p>
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[11px] ${
                                  isCurrent
                                    ? "bg-violet-100 text-violet-900 border border-violet-300 dark:bg-violet-500/20 dark:text-violet-100 dark:border-violet-500/30"
                                    : "bg-slate-100 text-slate-700 border border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600"
                                }`}
                              >
                                {isCurrent ? "当前策略" : scenario.knowledge_policy_id ? "已绑定其他策略" : "未绑定"}
                              </span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={bindingBusy || isCurrent}
                                onClick={() => void bindScenario(scenario, detail.id)}
                                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                              >
                                绑定当前策略
                              </button>
                              <button
                                type="button"
                                disabled={bindingBusy || !scenario.knowledge_policy_id}
                                onClick={() => void bindScenario(scenario, null)}
                                className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-40"
                              >
                                清空绑定
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
                <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-4 space-y-3">
                  <p className="text-sm font-medium text-slate-900 dark:text-white">策略编辑</p>
                  <label className="block text-sm">
                    <span className="text-slate-500">名称</span>
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-slate-500">说明</span>
                    <input
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-slate-500">配置 JSON</span>
                    <textarea
                      value={editConfigText}
                      onChange={(e) => setEditConfigText(e.target.value)}
                      rows={18}
                      className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm font-mono"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void savePolicy()}
                    disabled={saving}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    {saving ? "保存中…" : "保存策略"}
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-4">
                    <p className="text-sm font-medium text-slate-900 dark:text-white">治理轨迹</p>
                    <div className="mt-3 grid gap-2 text-sm text-slate-700 dark:text-slate-300">
                      <div className="flex items-center justify-between gap-3">
                        <span>审批人</span>
                        <span>{detail.approved_by || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>审批时间</span>
                        <span>{formatTime(detail.approved_at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>发布人</span>
                        <span>{detail.published_by || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>发布时间</span>
                        <span>{formatTime(detail.published_at)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>下线人</span>
                        <span>{detail.offlined_by || "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>下线时间</span>
                        <span>{formatTime(detail.offlined_at)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/40 p-4">
                    <p className="text-sm font-medium text-slate-900 dark:text-white">版本轨迹</p>
                    <div className="mt-3 space-y-2 max-h-[28rem] overflow-auto">
                      {versions.length === 0 ? (
                        <p className="text-sm text-slate-500">暂无版本记录。</p>
                      ) : (
                        versions.map((item) => (
                          <div
                            key={item.id}
                            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-slate-900 dark:text-white">
                                v{item.version}
                              </span>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_BADGE[item.status]}`}>
                                {STATUS_LABELS[item.status]}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{item.change_note || "—"}</p>
                            <p className="mt-1 text-[11px] text-slate-500">
                              {item.created_by || "system"} · {formatTime(item.created_at)}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
