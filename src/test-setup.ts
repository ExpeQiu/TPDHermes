import { beforeEach } from "vitest";

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

Object.defineProperty(globalThis, "localStorage", {
  value: createStorageMock(),
  configurable: true,
});

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  value: true,
  configurable: true,
});

if (!globalThis.requestAnimationFrame) {
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    configurable: true,
  });
}

if (!globalThis.cancelAnimationFrame) {
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: (handle: number) => clearTimeout(handle),
    configurable: true,
  });
}

beforeEach(() => {
  globalThis.localStorage.clear();
});
