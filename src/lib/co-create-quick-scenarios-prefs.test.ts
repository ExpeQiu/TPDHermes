import { beforeEach, describe, expect, it } from "vitest";

import {
  CO_CREATE_QUICK_ENTRY_LIMIT,
  loadCoCreateQuickScenariosPrefs,
  saveCoCreateQuickScenariosPrefs,
  toggleCoCreateQuickScenario,
} from "@/lib/co-create-quick-scenarios-prefs";

const SCOPE = "test-user";

describe("co-create-quick-scenarios-prefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("新增与移除快捷场景", () => {
    const added = toggleCoCreateQuickScenario(SCOPE, "s1");
    expect(added.action).toBe("added");
    expect(loadCoCreateQuickScenariosPrefs(SCOPE).scenarioIds).toEqual(["s1"]);

    const removed = toggleCoCreateQuickScenario(SCOPE, "s1");
    expect(removed.action).toBe("removed");
    expect(loadCoCreateQuickScenariosPrefs(SCOPE).scenarioIds).toEqual([]);
  });

  it("达到上限后不再添加", () => {
    const ids = Array.from({ length: CO_CREATE_QUICK_ENTRY_LIMIT }, (_, i) => `s${i}`);
    saveCoCreateQuickScenariosPrefs(SCOPE, { scenarioIds: ids });

    const result = toggleCoCreateQuickScenario(SCOPE, "overflow");
    expect(result.action).toBe("at_limit");
    expect(loadCoCreateQuickScenariosPrefs(SCOPE).scenarioIds).toHaveLength(
      CO_CREATE_QUICK_ENTRY_LIMIT,
    );
  });
});
