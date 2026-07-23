/** 防 React Strict / 竞态导致同一项目短时间重复误建空「新共创」 */
const CO_CREATE_ENTRY_CREATE_DEDUP_MS = 8_000;
const coCreateEntryCreateAtByProject = new Map<string, number>();

export function shouldSkipDuplicateEntryCreate(projectId: string): boolean {
  const lastAt = coCreateEntryCreateAtByProject.get(projectId) ?? 0;
  return Date.now() - lastAt < CO_CREATE_ENTRY_CREATE_DEDUP_MS;
}

export function markEntryCreate(projectId: string): void {
  coCreateEntryCreateAtByProject.set(projectId, Date.now());
}

export function clearEntryCreateGuard(projectId: string): void {
  coCreateEntryCreateAtByProject.delete(projectId);
}

/** 测试用：清空入口误建去重状态 */
export function resetCoCreateEntryCreateGuardForTests(): void {
  coCreateEntryCreateAtByProject.clear();
}
