import type { TaskInputPayload } from "@/lib/chat-context";
import type { ProjectQuickScenarios } from "@/lib/project-quick-scenarios";
import { resolveWorkshopScenarioId } from "@/lib/project-quick-scenarios";
import {
  isScenarioPublished,
  type ScenarioListItem,
} from "@/lib/scenario-list";

export type WorkshopBoundScenario = {
  scenario_id: string;
  enabled: number;
  is_default: number;
};

export type WorkshopSubmitReadinessInput = {
  selectedProjectId: string;
  selectedScenarioId: string;
  loadingBound: boolean;
  scenarioListItems: ScenarioListItem[];
  loadingScenarioDetail: boolean;
  hasScenarioDetail: boolean;
  runSkillNames: string[];
  selectedSkill: string | null;
  genStatus: "idle" | "generating" | "done" | "error";
};

export function isWorkshopSelectableScenario(item: ScenarioListItem): boolean {
  if (item.isLocalTemplate) return false;
  return isScenarioPublished(item.remote);
}

export function sortWorkshopDisplayScenarios(
  items: ScenarioListItem[],
  quickScenarioIds: Set<string>,
  boundScenarioIds: Set<string>,
): ScenarioListItem[] {
  const published = items.filter((item) => isWorkshopSelectableScenario(item));
  return published.sort((a, b) => {
    const aQuick = quickScenarioIds.has(a.id) ? 0 : 1;
    const bQuick = quickScenarioIds.has(b.id) ? 0 : 1;
    if (aQuick !== bQuick) return aQuick - bQuick;
    const aBound = boundScenarioIds.has(a.id) ? 0 : 1;
    const bBound = boundScenarioIds.has(b.id) ? 0 : 1;
    if (aBound !== bBound) return aBound - bBound;
    return a.title.localeCompare(b.title, "zh-CN");
  });
}

export function resolveWorkshopDefaultScenarioId(input: {
  displayScenarios: ScenarioListItem[];
  selectedProjectId: string;
  scenarioFromUrl: string;
  currentScenarioId: string;
  projectQuickScenarios: ProjectQuickScenarios | null;
  boundScenarios: WorkshopBoundScenario[];
}): string {
  const { displayScenarios } = input;
  if (displayScenarios.length === 0) return "";

  const inDisplay = (id: string) => displayScenarios.some((s) => s.id === id);

  if (input.scenarioFromUrl && inDisplay(input.scenarioFromUrl)) {
    return input.scenarioFromUrl;
  }
  if (input.currentScenarioId && inDisplay(input.currentScenarioId)) {
    return input.currentScenarioId;
  }
  if (input.selectedProjectId) {
    const quickDefault = resolveWorkshopScenarioId(input.projectQuickScenarios);
    if (quickDefault && inDisplay(quickDefault)) {
      return quickDefault;
    }
    const def = input.boundScenarios.find((b) => b.enabled === 1 && b.is_default === 1);
    if (def?.scenario_id && inDisplay(def.scenario_id)) {
      return def.scenario_id;
    }
  }
  return displayScenarios[0]?.id ?? "";
}

export function getWorkshopSubmitBlockReason(
  input: Omit<WorkshopSubmitReadinessInput, "genStatus">,
): string | null {
  if (!input.selectedProjectId) return "请先选择关联项目";
  if (!input.selectedScenarioId) return "请先选择场景";
  if (input.loadingBound) return "项目绑定加载中…";
  const selectedItem = input.scenarioListItems.find((s) => s.id === input.selectedScenarioId);
  if (!selectedItem || !isWorkshopSelectableScenario(selectedItem)) {
    return "请选择已发布场景";
  }
  if (input.loadingScenarioDetail || !input.hasScenarioDetail) {
    return "场景合同加载中…";
  }
  if (input.runSkillNames.length === 0) return "当前场景未绑定可执行技能";
  if (input.runSkillNames.length > 1 && !(input.selectedSkill ?? input.runSkillNames[0])) {
    return "请选择一项执行技能";
  }
  return null;
}

export function canSubmitWorkshop(input: WorkshopSubmitReadinessInput): boolean {
  return getWorkshopSubmitBlockReason(input) === null && input.genStatus !== "generating";
}

export function buildWorkshopTaskInput(input: {
  taskTitleCustom: string;
  derivedTaskTitle: string;
  taskBackground: string;
  taskObjective: string;
  taskKeywords: string;
  taskExtra: string;
  taskTone: string;
  mode: "refine" | "generate";
  sourceMaterialPreview: string | null;
}): TaskInputPayload {
  const effTitle = input.taskTitleCustom.trim() || input.derivedTaskTitle;
  const kwParts = input.taskKeywords
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    title: effTitle,
    ...(input.taskBackground.trim() ? { background: input.taskBackground.trim() } : {}),
    ...(input.taskObjective.trim() ? { objective: input.taskObjective.trim() } : {}),
    ...(kwParts.length ? { keywords: kwParts } : {}),
    ...(input.taskExtra.trim() ? { extra: input.taskExtra.trim() } : {}),
    ...(input.taskTone.trim() ? { tone: input.taskTone.trim() } : {}),
    ...(input.mode === "refine" && input.sourceMaterialPreview?.trim()
      ? { source_material: input.sourceMaterialPreview }
      : {}),
  };
}
