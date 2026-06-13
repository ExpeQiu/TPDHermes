export interface KnowledgeQueryCache {
  fetch<T>(key: string, loader: () => Promise<T>, options?: { force?: boolean }): Promise<T>;
  invalidatePrefix(prefix: string): void;
  invalidateAll(): void;
}

export function createKnowledgeQueryCache(): KnowledgeQueryCache {
  const values = new Map<string, unknown>();
  const inflight = new Map<string, Promise<unknown>>();

  return {
    async fetch<T>(key: string, loader: () => Promise<T>, options?: { force?: boolean }) {
      const force = options?.force === true;
      if (!force && values.has(key)) {
        return values.get(key) as T;
      }
      if (!force && inflight.has(key)) {
        return inflight.get(key) as Promise<T>;
      }
      const task = loader()
        .then((result) => {
          values.set(key, result);
          inflight.delete(key);
          return result;
        })
        .catch((error) => {
          inflight.delete(key);
          throw error;
        });
      inflight.set(key, task as Promise<unknown>);
      return task;
    },
    invalidatePrefix(prefix: string) {
      for (const key of values.keys()) {
        if (key.startsWith(prefix)) values.delete(key);
      }
      for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) inflight.delete(key);
      }
    },
    invalidateAll() {
      values.clear();
      inflight.clear();
    },
  };
}

/** 跨页面导航复用的模块级缓存（组件卸载后仍保留，SSE/写操作可 invalidate） */
let sharedKnowledgeQueryCache: KnowledgeQueryCache | null = null;

export function getKnowledgeQueryCache(): KnowledgeQueryCache {
  if (!sharedKnowledgeQueryCache) {
    sharedKnowledgeQueryCache = createKnowledgeQueryCache();
  }
  return sharedKnowledgeQueryCache;
}
