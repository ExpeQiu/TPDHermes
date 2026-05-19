/**
 * 场景列表：与 `/create` Step 1 一致（服务端场景 + 未入库的内置模板）。
 * 工坊等页面复用同一数据源与展示字段，执行约束（绑定 / published）由调用方过滤。
 */

import { LOCAL_SCENARIO_IDS, SCENARIOS, type Scenario } from "@/lib/scenario-presets";

export type ScenarioApiRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  version: string;
};

export type ScenarioListItem = Scenario & {
  remote: ScenarioApiRow | null;
  isLocalTemplate: boolean;
};

export const DISMISSED_PRESETS_KEY = "tpd_create_dismissed_presets";

export function loadDismissedPresetIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(DISMISSED_PRESETS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export function scenarioFromRemoteRow(row: ScenarioApiRow): Scenario {
  return {
    id: row.id,
    title: row.name,
    summary: row.description ?? "服务端场景，可在场景编排中完善合同后保存。",
    goal: "请填写结果说明。",
    recommendedTemplate: "自定义",
    recommendedKnowledgeMode: "可选绑定知识库",
    recommendedSections: ["背景", "方案", "总结"],
    systemContext: row.description?.trim() || `协助完成「${row.name}」相关产出。`,
  };
}

/** 与 create 页 Step 1「场景列表」相同的合并规则 */
export function buildScenarioListItems(
  remoteList: ScenarioApiRow[],
  dismissedPresetIds: Set<string>,
): ScenarioListItem[] {
  const remoteIds = new Set(remoteList.map((r) => r.id));
  const serverItems: ScenarioListItem[] = remoteList.map((r) => {
    const base = scenarioFromRemoteRow(r);
    return { ...base, remote: r, isLocalTemplate: false };
  });
  const localTemplates: ScenarioListItem[] = SCENARIOS.filter(
    (s) => !remoteIds.has(s.id) && !dismissedPresetIds.has(s.id),
  ).map((s) => ({
    ...s,
    remote: null,
    isLocalTemplate: LOCAL_SCENARIO_IDS.has(s.id),
  }));
  return [...serverItems, ...localTemplates];
}

export function countLocalTemplates(
  remoteList: ScenarioApiRow[],
  dismissedPresetIds: Set<string>,
): number {
  return SCENARIOS.filter(
    (s) => !remoteList.some((r) => r.id === s.id) && !dismissedPresetIds.has(s.id),
  ).length;
}

export function isScenarioPublished(remote: ScenarioApiRow | null): boolean {
  if (!remote) return false;
  return (remote.status || "draft").toLowerCase() === "published";
}
