import { getEffectiveUserIdSync } from "@/lib/user-id";

/** 共创空态快捷入口上限：2 列 × 4 行 */
export const CO_CREATE_QUICK_ENTRY_LIMIT = 8;

export const CO_CREATE_QUICK_SCENARIOS_CHANGED = "tphermes:co-create-quick-scenarios-changed";

export type CoCreateQuickScenariosPrefs = {
  scenarioIds: string[];
};

export function coCreateQuickScenariosStorageKey(scopeUserId: string): string {
  return `tphermes-co-create-quick-scenarios:${scopeUserId}`;
}

export function loadCoCreateQuickScenariosPrefs(
  scopeUserId: string,
): CoCreateQuickScenariosPrefs {
  if (typeof window === "undefined") return { scenarioIds: [] };
  try {
    const raw = localStorage.getItem(coCreateQuickScenariosStorageKey(scopeUserId));
    if (!raw) return { scenarioIds: [] };
    const parsed = JSON.parse(raw) as CoCreateQuickScenariosPrefs;
    if (!parsed || !Array.isArray(parsed.scenarioIds)) return { scenarioIds: [] };
    return {
      scenarioIds: [...new Set(parsed.scenarioIds.filter((id) => typeof id === "string" && id))],
    };
  } catch {
    return { scenarioIds: [] };
  }
}

export function saveCoCreateQuickScenariosPrefs(
  scopeUserId: string,
  prefs: CoCreateQuickScenariosPrefs,
): void {
  if (typeof window === "undefined") return;
  const normalized: CoCreateQuickScenariosPrefs = {
    scenarioIds: [...new Set(prefs.scenarioIds)].slice(0, CO_CREATE_QUICK_ENTRY_LIMIT),
  };
  localStorage.setItem(
    coCreateQuickScenariosStorageKey(scopeUserId),
    JSON.stringify(normalized),
  );
  window.dispatchEvent(new Event(CO_CREATE_QUICK_SCENARIOS_CHANGED));
}

export function isCoCreateQuickScenario(scopeUserId: string, scenarioId: string): boolean {
  return loadCoCreateQuickScenariosPrefs(scopeUserId).scenarioIds.includes(scenarioId);
}

export type ToggleCoCreateQuickScenarioResult = {
  prefs: CoCreateQuickScenariosPrefs;
  action: "added" | "removed" | "at_limit";
};

/** 切换当前场景是否在共创快捷入口列表中（新增排到末尾，满额不再添加） */
export function toggleCoCreateQuickScenario(
  scopeUserId: string,
  scenarioId: string,
): ToggleCoCreateQuickScenarioResult {
  const current = loadCoCreateQuickScenariosPrefs(scopeUserId);
  if (current.scenarioIds.includes(scenarioId)) {
    const prefs = {
      scenarioIds: current.scenarioIds.filter((id) => id !== scenarioId),
    };
    saveCoCreateQuickScenariosPrefs(scopeUserId, prefs);
    return { prefs, action: "removed" };
  }
  if (current.scenarioIds.length >= CO_CREATE_QUICK_ENTRY_LIMIT) {
    return { prefs: current, action: "at_limit" };
  }
  const prefs = { scenarioIds: [...current.scenarioIds, scenarioId] };
  saveCoCreateQuickScenariosPrefs(scopeUserId, prefs);
  return { prefs, action: "added" };
}

export function coCreateQuickScenariosScopeId(): string {
  if (typeof window === "undefined") return "default";
  return getEffectiveUserIdSync() || "default";
}
