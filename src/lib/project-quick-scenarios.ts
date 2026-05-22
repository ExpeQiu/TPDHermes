import { getEffectiveUserIdSync } from "@/lib/user-id";

export type ProjectQuickScenarios = {
  scenarioIds: string[];
  defaultScenarioId: string | null;
};

export function quickScenariosScopeId(): string {
  if (typeof window === "undefined") return "default";
  return getEffectiveUserIdSync() || "default";
}

export function quickScenariosStorageKey(scopeUserId: string, projectId: string): string {
  return `tphermes-project-quick-scenarios:${scopeUserId}:${projectId}`;
}

export function loadProjectQuickScenarios(
  scopeUserId: string,
  projectId: string,
): ProjectQuickScenarios | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(quickScenariosStorageKey(scopeUserId, projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectQuickScenarios;
    if (!parsed || !Array.isArray(parsed.scenarioIds)) return null;
    return {
      scenarioIds: parsed.scenarioIds.filter((id) => typeof id === "string" && id.length > 0),
      defaultScenarioId:
        typeof parsed.defaultScenarioId === "string" ? parsed.defaultScenarioId : null,
    };
  } catch {
    return null;
  }
}

export function saveProjectQuickScenarios(
  scopeUserId: string,
  projectId: string,
  data: ProjectQuickScenarios,
): void {
  if (typeof window === "undefined") return;
  const normalized: ProjectQuickScenarios = {
    scenarioIds: [...new Set(data.scenarioIds)],
    defaultScenarioId:
      data.defaultScenarioId && data.scenarioIds.includes(data.defaultScenarioId)
        ? data.defaultScenarioId
        : data.scenarioIds[0] ?? null,
  };
  localStorage.setItem(
    quickScenariosStorageKey(scopeUserId, projectId),
    JSON.stringify(normalized),
  );
}

export function resolveWorkshopScenarioId(quick: ProjectQuickScenarios | null): string | null {
  if (!quick || quick.scenarioIds.length === 0) return null;
  if (quick.defaultScenarioId && quick.scenarioIds.includes(quick.defaultScenarioId)) {
    return quick.defaultScenarioId;
  }
  return quick.scenarioIds[0] ?? null;
}

type CatalogRow = { id: string; version: string };
type BoundRow = {
  scenario_id: string;
  enabled: number;
  scenario_version?: string;
};

/** 将快捷场景勾选同步到项目绑定（供工坊执行白名单） */
export async function syncQuickScenariosToProjectBindings(
  projectId: string,
  quick: ProjectQuickScenarios,
  catalog: CatalogRow[],
  bound: BoundRow[],
  fetchFn: (path: string, init?: RequestInit) => Promise<Response>,
  readJsonFn: <T>(res: Response) => Promise<T>,
): Promise<void> {
  const target = new Set(quick.scenarioIds);
  const enabled = bound.filter((b) => b.enabled === 1);

  for (const row of enabled) {
    if (!target.has(row.scenario_id)) {
      const res = await fetchFn(`/projects/${projectId}/scenarios/${row.scenario_id}`, {
        method: "DELETE",
      });
      await readJsonFn(res);
    }
  }

  for (const scenarioId of quick.scenarioIds) {
    const cat = catalog.find((c) => c.id === scenarioId);
    if (!cat) continue;
    const existing = enabled.find((b) => b.scenario_id === scenarioId);
    if (existing) {
      if (existing.scenario_version && existing.scenario_version !== cat.version) {
        const res = await fetchFn(`/projects/${projectId}/scenarios/${scenarioId}/version`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenario_version: cat.version }),
        });
        await readJsonFn(res);
      }
      continue;
    }
    const res = await fetchFn(`/projects/${projectId}/scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scenario_id: cat.id,
        scenario_version: cat.version,
        is_default: false,
      }),
    });
    await readJsonFn(res);
  }

  const defaultId = resolveWorkshopScenarioId(quick);
  if (defaultId && target.has(defaultId)) {
    const res = await fetchFn(`/projects/${projectId}/scenarios/${defaultId}/default`, {
      method: "POST",
    });
    await readJsonFn(res);
  }
}
