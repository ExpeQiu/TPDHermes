"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";

export type BrainstormAttachment = {
  id: string;
  original_filename: string;
  content_type?: string | null;
  size_bytes?: number;
  ingest_status?: string | null;
};

export type BrainstormSetupValues = {
  topic: string;
  description: string;
  rounds: number;
  demo: boolean;
  pack: string;
  selectedAttachmentIds: string[];
  discussionMode: "round_robin" | "parallel" | "debate";
  consensusEnabled: boolean;
  consensusThreshold: number;
  proRoleIds: string[];
  conRoleIds: string[];
  judgeRoleId: string;
  moderatorEnabled: boolean;
};

type RoundtableRole = {
  id: string;
  name: string;
  perspective: string;
  kind: "expert" | "moderator";
};

const MODERATOR_ROLE: RoundtableRole = {
  id: "moderator",
  name: "主持人",
  perspective: "控场、升维冲突、收束可执行方案",
  kind: "moderator",
};

/** Pack 切换失败时的本地圆桌席位 fallback（与 skill_packs 下各 pack.yml 对齐） */
const PACK_ROLES_FALLBACK: Record<string, RoundtableRole[]> = {
  "tech-ip": [
    {
      id: "ip_strategist",
      name: "IP策略师",
      perspective: "IP全案、矩阵货架、命名定位、技术品牌与车型互锁",
      kind: "expert",
    },
    {
      id: "brand_researcher",
      name: "品牌调研官",
      perspective: "调研洞察、趋势判断、竞品对标证据",
      kind: "expert",
    },
    {
      id: "comm_planner",
      name: "传播策划官",
      perspective: "传播目标、受众分层、节奏ROADMAP、认证权益",
      kind: "expert",
    },
    MODERATOR_ROLE,
  ],
  "content-lab": [
    {
      id: "content_director",
      name: "内容导演",
      perspective: "叙事结构、话术落地、证据点与CTA",
      kind: "expert",
    },
    {
      id: "video_director",
      name: "视频导演",
      perspective: "钩子、分镜、完播与技术展示节奏",
      kind: "expert",
    },
    {
      id: "brand_researcher",
      name: "品牌调研官",
      perspective: "调研洞察、趋势判断、竞品对标证据",
      kind: "expert",
    },
    MODERATOR_ROLE,
  ],
  "exhibit-event": [
    {
      id: "exhibit_designer",
      name: "展具体验师",
      perspective: "展具概念、互动体验、制作预算与交付规范",
      kind: "expert",
    },
    {
      id: "event_producer",
      name: "活动制片人",
      perspective: "参展目标、展台节奏、代言人与任务分工",
      kind: "expert",
    },
    {
      id: "content_director",
      name: "内容导演",
      perspective: "叙事结构、话术落地、证据点与CTA",
      kind: "expert",
    },
    MODERATOR_ROLE,
  ],
  "sales-gtm": [
    {
      id: "sales_coach",
      name: "销售话术教练",
      perspective: "开场、卖点、场景、异议处理与逼单",
      kind: "expert",
    },
    {
      id: "material_planner",
      name: "物料统筹",
      perspective: "视频/图文/KOL/媒介物料齐套与投放节奏",
      kind: "expert",
    },
    {
      id: "brand_researcher",
      name: "品牌调研官",
      perspective: "调研洞察、趋势判断、竞品对标证据",
      kind: "expert",
    },
    MODERATOR_ROLE,
  ],
};

function rolesForPack(packId: string): RoundtableRole[] {
  return PACK_ROLES_FALLBACK[packId] ?? PACK_ROLES_FALLBACK["tech-ip"];
}

function debateDefaultsFromExperts(experts: RoundtableRole[]) {
  const ids = experts.map((r) => r.id);
  const mid = Math.ceil(ids.length / 2) || 0;
  return {
    proRoleIds: ids.slice(0, mid),
    conRoleIds: ids.slice(mid),
    judgeRoleId: "moderator",
  };
}

function mapPackRoles(
  rows: Array<{ id?: string; name?: string; perspective?: string }> | undefined,
  fallback: RoundtableRole[],
): RoundtableRole[] {
  if (!rows?.length) return fallback;
  return rows
    .map((r) => {
      const id = String(r.id || "").trim();
      if (!id) return null;
      return {
        id,
        name: String(r.name || id).trim() || id,
        perspective: String(r.perspective || "").trim(),
        kind: (id === "moderator" ? "moderator" : "expert") as RoundtableRole["kind"],
      };
    })
    .filter((r): r is RoundtableRole => r != null);
}

const DISCUSSION_MODE_OPTIONS = [
  {
    id: "round_robin" as const,
    title: "轮流发言",
    desc: "专家按顺序依次发言，讨论更有条理",
  },
  {
    id: "parallel" as const,
    title: "并行模式",
    desc: "同轮专家同时发言，讨论更高效",
  },
  {
    id: "debate" as const,
    title: "正反方辩论",
    desc: "正反方交替发言，裁判点评后收束",
  },
];

const PACK_OPTIONS = [
  {
    id: "tech-ip",
    name: "技术IP包装",
    description: "IP全案、调研对标与传播认证圆桌",
  },
  {
    id: "content-lab",
    name: "技术内容生产",
    description: "讲稿/新闻稿/视频/知识收割内容线",
  },
  {
    id: "exhibit-event",
    name: "展具与活动",
    description: "展具体验与技术推广活动策划",
  },
  {
    id: "sales-gtm",
    name: "销售与物料落地",
    description: "终端话术与传播物料齐套",
  },
] as const;

type Props = {
  projectName: string;
  projectBackground?: string | null;
  attachments: BrainstormAttachment[];
  attachmentsLoading?: boolean;
  values: BrainstormSetupValues;
  onChange: (patch: Partial<BrainstormSetupValues>) => void;
  running: boolean;
  engineReady: boolean | null;
  engineHint?: string | null;
  onSubmit: () => void;
};

function formatFileSize(bytes?: number) {
  if (bytes == null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrainstormSetupPanel({
  projectName,
  projectBackground,
  attachments,
  attachmentsLoading,
  values,
  onChange,
  running,
  engineReady,
  engineHint,
  onSubmit,
}: Props) {
  const selectedCount = values.selectedAttachmentIds.length;
  const canSubmit = Boolean(values.topic.trim()) && !running;
  const selectedPack = PACK_OPTIONS.find((p) => p.id === values.pack) ?? PACK_OPTIONS[0];
  const [roles, setRoles] = useState<RoundtableRole[]>(() => rolesForPack(values.pack));
  const expertRoles = useMemo(
    () => roles.filter((r) => r.kind === "expert"),
    [roles],
  );

  useEffect(() => {
    let cancelled = false;
    const fallback = rolesForPack(values.pack);
    setRoles(fallback);
    apiGet<{
      roundtable_roles?: Array<{ id?: string; name?: string; perspective?: string }>;
    }>(`/brainstorm/packs/${encodeURIComponent(values.pack)}`)
      .then((data) => {
        if (cancelled) return;
        setRoles(mapPackRoles(data.roundtable_roles, fallback));
      })
      .catch(() => {
        /* 保持 fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [values.pack]);

  const selectPack = (packId: string) => {
    if (running) return;
    const nextRoles = rolesForPack(packId);
    const experts = nextRoles.filter((r) => r.kind === "expert");
    onChange({ pack: packId, ...debateDefaultsFromExperts(experts) });
  };

  const selectedAttachmentNames = useMemo(() => {
    const set = new Set(values.selectedAttachmentIds);
    return attachments.filter((a) => set.has(a.id)).map((a) => a.original_filename);
  }, [attachments, values.selectedAttachmentIds]);

  const toggleAttachment = (id: string) => {
    if (running) return;
    const set = new Set(values.selectedAttachmentIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ selectedAttachmentIds: Array.from(set) });
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white/90 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      {/* 顶栏：会话创建感 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 sm:px-6 dark:border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            创建头脑风暴会话
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            项目「{projectName}」· 配置议题、参考材料与辩论参数后启动圆桌
          </p>
        </div>
        {engineReady != null ? (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
              engineReady
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
                : "bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
            }`}
            title={engineHint || undefined}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                engineReady ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {engineReady ? "引擎就绪" : "引擎未就绪"}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-[28rem] flex-col lg:flex-row">
        {/* 左侧：来源 + 专家（对齐 todify4 Setup） */}
        <aside className="flex w-full flex-col border-b border-slate-200 bg-slate-50/80 lg:w-80 lg:shrink-0 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-950/40">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              来源信息
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              当前项目附件 {attachments.length} 条，已勾选 {selectedCount} 条
            </p>
          </div>
          <div className="max-h-48 space-y-2 overflow-y-auto p-3 lg:max-h-56">
            {attachmentsLoading ? (
              <p className="py-8 text-center text-xs text-slate-500">加载附件中…</p>
            ) : attachments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 px-3 py-8 text-center text-xs leading-relaxed text-slate-500 dark:border-slate-700">
                暂无项目附件。
                <br />
                在项目控制台上传后，可勾选并抽取正文注入 multi-agent，供专家团研讨引用。
              </div>
            ) : (
              attachments.slice(0, 30).map((a) => {
                const checked = values.selectedAttachmentIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-2.5 transition ${
                      checked
                        ? "border-amber-400 bg-amber-50/80 dark:border-amber-600/60 dark:bg-amber-950/30"
                        : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
                    } ${running ? "pointer-events-none opacity-60" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAttachment(a.id)}
                      disabled={running}
                      className="mt-0.5 rounded border-slate-400"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-xs font-medium text-slate-900 dark:text-slate-100">
                        {a.original_filename}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                        {formatFileSize(a.size_bytes) ? (
                          <span>{formatFileSize(a.size_bytes)}</span>
                        ) : null}
                        {a.ingest_status ? (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
                            {a.ingest_status}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </label>
                );
              })
            )}
          </div>

          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              专家团
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              选择专家团（Skill Pack），决定参与专家与主持人预设
            </p>
            <div className="mt-3 space-y-2">
              {PACK_OPTIONS.map((pack) => {
                const active = values.pack === pack.id;
                return (
                  <button
                    key={pack.id}
                    type="button"
                    disabled={running}
                    onClick={() => selectPack(pack.id)}
                    className={`w-full rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${
                      active
                        ? "border-amber-400 bg-amber-50/80 dark:border-amber-600/60 dark:bg-amber-950/30"
                        : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
                    }`}
                  >
                    <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                      {pack.name}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      {pack.description}
                    </span>
                    <span className="mt-1 block font-mono text-[11px] text-slate-400">
                      {pack.id}
                    </span>
                  </button>
                );
              })}
            </div>
            {engineHint ? (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                {engineHint}
              </p>
            ) : null}
          </div>

          <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              参与专家
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              当前专家团「{selectedPack?.name || values.pack}」· {roles.length}{" "}
              位
            </p>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {roles.map((role) => (
              <div
                key={role.id}
                className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
              >
                <div className="flex items-start gap-2.5">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
                      role.kind === "moderator"
                        ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
                    }`}
                  >
                    {role.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {role.name}
                      </span>
                      {role.kind === "moderator" ? (
                        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">
                          主持人
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                      {role.perspective}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* 右侧：议题与参数 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
            {projectBackground?.trim() ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-400">
                <span className="font-medium text-slate-800 dark:text-slate-200">
                  项目背景摘录
                </span>
                <p className="mt-1 line-clamp-3">{projectBackground.trim()}</p>
              </div>
            ) : null}

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-800 dark:text-slate-200">
                讨论话题 <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={values.topic}
                onChange={(e) => onChange({ topic: e.target.value })}
                disabled={running}
                placeholder="例如：半固态电池如何对外讲清楚"
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 outline-none ring-amber-400/40 focus:ring-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-800 dark:text-slate-200">
                话题描述（可选）
              </label>
              <textarea
                value={values.description}
                onChange={(e) => onChange({ description: e.target.value })}
                disabled={running}
                rows={4}
                placeholder="补充讨论背景、目标约束、期望产出…"
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm leading-relaxed text-slate-900 outline-none ring-amber-400/40 focus:ring-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              {selectedAttachmentNames.length > 0 ? (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  启动时将抽取已选附件正文并注入专家团研讨上下文：
                  {selectedAttachmentNames.join("、")}
                </p>
              ) : null}
            </div>

            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <h3 className="mb-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                讨论模式
              </h3>
              <div className="space-y-2">
                {DISCUSSION_MODE_OPTIONS.map((opt) => {
                  const active = values.discussionMode === opt.id;
                  return (
                    <label
                      key={opt.id}
                      className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-3 transition ${
                        active
                          ? "border-amber-400 bg-amber-50/70 dark:border-amber-600/50 dark:bg-amber-950/30"
                          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-950/40"
                      } ${running ? "pointer-events-none opacity-60" : ""}`}
                    >
                      <input
                        type="radio"
                        name="discussionMode"
                        checked={active}
                        disabled={running}
                        onChange={() => onChange({ discussionMode: opt.id })}
                        className="mt-1 border-slate-400"
                      />
                      <span>
                        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                          {opt.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                          {opt.desc}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              {values.discussionMode === "debate" ? (
                <div className="mt-4 space-y-4 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4 dark:border-indigo-800/40 dark:bg-indigo-950/20">
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    未勾选时引擎将自动均分专家为正反方；裁判默认由主持人担任。
                  </p>
                  <div>
                    <p className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                      正方
                    </p>
                    <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-950">
                      {expertRoles.map((role) => {
                        const inCon = values.conRoleIds.includes(role.id);
                        const checked = values.proRoleIds.includes(role.id);
                        return (
                          <label
                            key={`pro-${role.id}`}
                            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                              inCon ? "opacity-40" : "hover:bg-slate-50 dark:hover:bg-slate-900"
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={running || inCon}
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...values.proRoleIds, role.id]
                                  : values.proRoleIds.filter((id) => id !== role.id);
                                onChange({ proRoleIds: next });
                              }}
                            />
                            <span>{role.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                      反方
                    </p>
                    <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-950">
                      {expertRoles.map((role) => {
                        const inPro = values.proRoleIds.includes(role.id);
                        const checked = values.conRoleIds.includes(role.id);
                        return (
                          <label
                            key={`con-${role.id}`}
                            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                              inPro ? "opacity-40" : "hover:bg-slate-50 dark:hover:bg-slate-900"
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={running || inPro}
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...values.conRoleIds, role.id]
                                  : values.conRoleIds.filter((id) => id !== role.id);
                                onChange({ conRoleIds: next });
                              }}
                            />
                            <span>{role.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-800 dark:text-slate-200">
                      裁判（可选）
                    </label>
                    <select
                      value={values.judgeRoleId}
                      disabled={running}
                      onChange={(e) => onChange({ judgeRoleId: e.target.value })}
                      className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="">默认主持人</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-slate-200 pt-5 dark:border-slate-800">
              <h3 className="mb-3 text-sm font-medium text-slate-900 dark:text-slate-100">
                终止条件
              </h3>
              <label className="mb-2 block text-sm text-slate-700 dark:text-slate-300">
                最大轮次
              </label>
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3, 4, 5].map((n) => {
                  const active = values.rounds === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={running}
                      onClick={() => onChange({ rounds: n })}
                      className={`min-w-[2.75rem] rounded-xl border px-3 py-2 text-sm font-medium transition disabled:opacity-60 ${
                        active
                          ? "border-amber-500 bg-amber-500 text-white shadow-sm"
                          : "border-slate-300 bg-white text-slate-700 hover:border-amber-300 hover:bg-amber-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-amber-700 dark:hover:bg-amber-950/30"
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                每位专家每轮发言一次；达到轮次或共识后由引擎收束方案。
              </p>
              {values.rounds >= 4 && !values.demo ? (
                <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                  Live 模式下 {values.rounds} 轮通常需要约 {Math.max(5, values.rounds)}–
                  {values.rounds * 2} 分钟。若共识未达成会跑满全部轮次，请耐心等待，勿重复提交。
                </p>
              ) : null}

              <label
                className={`mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
                  values.consensusEnabled
                    ? "border-sky-300 bg-sky-50/70 dark:border-sky-700/50 dark:bg-sky-950/30"
                    : "border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-950/30"
                } ${running ? "pointer-events-none opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={values.consensusEnabled}
                  onChange={(e) => onChange({ consensusEnabled: e.target.checked })}
                  disabled={running}
                  className="mt-1 rounded border-slate-400"
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                    启用共识检测（提前终止）
                  </span>
                  <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                    由 multi-agent 引擎在每轮后判断是否可收束；达到阈值则提前结束。
                  </span>
                  {values.consensusEnabled ? (
                    <span className="mt-3 block">
                      <span className="mb-1 block text-xs text-slate-600 dark:text-slate-400">
                        共识阈值：{values.consensusThreshold.toFixed(1)}
                      </span>
                      <input
                        type="range"
                        min={0.5}
                        max={1}
                        step={0.1}
                        value={values.consensusThreshold}
                        disabled={running}
                        onChange={(e) =>
                          onChange({ consensusThreshold: Number(e.target.value) })
                        }
                        className="w-full"
                      />
                    </span>
                  ) : null}
                </span>
              </label>

              <label
                className={`mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300 ${
                  running ? "opacity-60" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={values.moderatorEnabled}
                  disabled={running}
                  onChange={(e) => onChange({ moderatorEnabled: e.target.checked })}
                  className="rounded border-slate-400"
                />
                启用主持人升维 / 收束
              </label>
            </div>
          </div>

          {/* 底栏 CTA */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/90 px-5 py-4 sm:px-6 dark:border-slate-800 dark:bg-slate-950/50">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {running
                ? values.rounds >= 4 && !values.demo
                  ? `圆桌进行中（Live · ${values.rounds} 轮可能需数分钟）…`
                  : "圆桌进行中，请稍候…"
                : canSubmit
                  ? `即将启动 ${values.rounds} 轮 · ${
                      values.discussionMode === "debate"
                        ? "辩论"
                        : values.discussionMode === "parallel"
                          ? "并行"
                          : "轮流"
                    }${
                      values.rounds >= 4 && !values.demo
                        ? ` · 预计 ${Math.max(5, values.rounds)}–${values.rounds * 2} 分钟`
                        : ""
                    }`
                  : "请先填写讨论话题"}
            </p>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              className="rounded-xl border border-amber-400 bg-amber-500 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running ? "圆桌进行中…" : "开始头脑风暴"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 将 UI 配置拼成上游 roundtable topic */
export function buildBrainstormTopic(values: BrainstormSetupValues, attachmentNames: string[]) {
  const parts: string[] = [values.topic.trim()];
  const desc = values.description.trim();
  if (desc) parts.push(`背景：${desc}`);
  if (attachmentNames.length > 0) {
    parts.push(`参考附件：${attachmentNames.join("、")}`);
  }
  return parts.join("\n\n");
}
