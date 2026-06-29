/**
 * 共创空态「快捷创作入口」：与 `/create` Step 1 场景列表同源。
 */

import {
  CO_CREATE_QUICK_ENTRY_LIMIT,
  type CoCreateQuickScenariosPrefs,
} from "@/lib/co-create-quick-scenarios-prefs";
import type { ProjectQuickScenarios } from "@/lib/project-quick-scenarios";
import {
  isScenarioPublished,
  type ScenarioListItem,
} from "@/lib/scenario-list";

export { CO_CREATE_QUICK_ENTRY_LIMIT };

export const CO_CREATE_QUICK_ENTRY_ACCENTS = [
  "from-blue-600 to-indigo-600",
  "from-violet-600 to-purple-600",
  "from-amber-600 to-orange-600",
  "from-emerald-600 to-teal-600",
  "from-rose-600 to-pink-600",
  "from-cyan-600 to-sky-600",
  "from-lime-600 to-green-600",
  "from-fuchsia-600 to-purple-600",
] as const;

export type CoCreateQuickEntry = {
  id: string;
  scenarioId: string;
  title: string;
  prompt: string;
  presetInstructions: string;
  accent: string;
};

export function buildCoCreateQuickPrompt(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return "请基于当前项目上下文完成本场景的创作任务。";
  if (/^请/.test(trimmed)) return trimmed;
  return `请基于当前项目上下文，${trimmed}`;
}

export function resolveCoCreatePresetInstructions(item: ScenarioListItem): string {
  return item.systemContext?.trim() || item.summary?.trim() || "";
}

export function scenarioListItemToQuickEntry(
  item: ScenarioListItem,
  index: number,
): CoCreateQuickEntry {
  const goal = item.goal?.trim() || item.summary?.trim() || "";
  return {
    id: item.id,
    scenarioId: item.id,
    title: item.title,
    prompt: buildCoCreateQuickPrompt(goal),
    presetInstructions: resolveCoCreatePresetInstructions(item),
    accent: CO_CREATE_QUICK_ENTRY_ACCENTS[index % CO_CREATE_QUICK_ENTRY_ACCENTS.length],
  };
}

export type CoCreateQuickSelectionOptions = {
  limit?: number;
  globalQuickPrefs?: CoCreateQuickScenariosPrefs | null;
  projectQuickPrefs?: ProjectQuickScenarios | null;
};

function pickScenariosByIds(
  items: ScenarioListItem[],
  ids: string[],
): ScenarioListItem[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return ids
    .map((id) => byId.get(id))
    .filter((item): item is ScenarioListItem => Boolean(item));
}

/** 与 create 页设定一致：全局快捷入口 > 项目快捷勾选 > 已发布场景 > 列表前 N 项 */
export function selectCoCreateQuickScenarios(
  items: ScenarioListItem[],
  options?: CoCreateQuickSelectionOptions,
): ScenarioListItem[] {
  const limit = options?.limit ?? CO_CREATE_QUICK_ENTRY_LIMIT;

  const globalIds = options?.globalQuickPrefs?.scenarioIds ?? [];
  if (globalIds.length > 0) {
    const picked = pickScenariosByIds(items, globalIds);
    if (picked.length > 0) return picked.slice(0, limit);
  }

  const projectIds = options?.projectQuickPrefs?.scenarioIds ?? [];
  if (projectIds.length > 0) {
    const picked = pickScenariosByIds(items, projectIds);
    if (picked.length > 0) return picked.slice(0, limit);
  }

  const published = items.filter((item) => isScenarioPublished(item.remote));
  if (published.length > 0) return published.slice(0, limit);

  return items.slice(0, limit);
}

export function buildCoCreateQuickEntries(
  items: ScenarioListItem[],
  options?: CoCreateQuickSelectionOptions,
): CoCreateQuickEntry[] {
  return selectCoCreateQuickScenarios(items, options).map(scenarioListItemToQuickEntry);
}
