/** localStorage：用户隔离 ID（与设置页、API 头共享） */
import { apiV1, readJson } from "./api";

export const USER_ID_STORAGE_KEY = "tpdhermes_user_id";

export const FEISHU_SESSION_STORAGE_KEY = "tpdhermes_feishu_session";

let derivedUserIdCache: string | null = null;
let derivedUserIdPromise: Promise<string> | null = null;

/** 与 X-User-ID 一致：空串归一为 default（仅用于用户显式保存/输入） */
export function normalizeUserId(value: string): string {
  return value.trim() || "default";
}

export function loadUserIdFromStorage(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(USER_ID_STORAGE_KEY)?.trim() || "";
}

export function hasStoredUserId(): boolean {
  return Boolean(loadUserIdFromStorage());
}

/** 本机已保存或已拉取的 IP+UA 匿名 ID；未就绪时返回空串 */
export function getEffectiveUserIdSync(): string {
  const stored = loadUserIdFromStorage();
  if (stored) return normalizeUserId(stored);
  return derivedUserIdCache?.trim() || "";
}

/** 请求后端按 IP+UA 推导 auto_*（结果缓存于内存） */
export async function fetchDerivedUserId(): Promise<string> {
  if (derivedUserIdCache) return derivedUserIdCache;
  if (!derivedUserIdPromise) {
    derivedUserIdPromise = (async () => {
      const res = await fetch(apiV1("/me/derived-user-id"));
      const data = await readJson<{ user_id: string }>(res);
      const id = (data.user_id || "").trim();
      if (!id) throw new Error("服务端未返回有效 user_id");
      derivedUserIdCache = id;
      return id;
    })().finally(() => {
      derivedUserIdPromise = null;
    });
  }
  return derivedUserIdPromise;
}

/** 无本地保存时预拉取匿名 ID，供多标签与 API 头使用 */
export async function ensureDerivedUserId(): Promise<string> {
  if (hasStoredUserId()) return getEffectiveUserIdSync();
  return fetchDerivedUserId();
}

export function loadFeishuSessionFromStorage(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(FEISHU_SESSION_STORAGE_KEY)?.trim() || "";
}
