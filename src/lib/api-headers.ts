/**
 * 与后端 user_identity / RBAC 对齐：X-User-ID、X-User-Role、飞书会话。
 */
import {
  FEISHU_SESSION_STORAGE_KEY,
  USER_ID_STORAGE_KEY,
  ensureDerivedUserId,
  getEffectiveUserIdSync,
  loadFeishuSessionFromStorage,
  normalizeUserId,
} from "./user-id";

import { USER_ROLE_STORAGE_KEY } from "./rbac";

export function loadUserRoleFromStorage(): string {
  if (typeof window === "undefined") return "";
  const fromStorage = window.localStorage.getItem(USER_ROLE_STORAGE_KEY)?.trim();
  if (fromStorage) return fromStorage;
  const fromEnv = process.env.NEXT_PUBLIC_DEFAULT_USER_ROLE?.trim();
  if (fromEnv) return fromEnv;
  return "tenant_admin";
}

export function getApiHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const headers: Record<string, string> = {
    "X-User-Role": loadUserRoleFromStorage(),
  };
  const userId = getEffectiveUserIdSync();
  if (userId) {
    headers["X-User-ID"] = userId;
  }
  const sess =
    loadFeishuSessionFromStorage().trim() ||
    (typeof window !== "undefined"
      ? window.sessionStorage.getItem(FEISHU_SESSION_STORAGE_KEY)?.trim() || ""
      : "");
  if (sess) {
    headers["X-Feishu-Session-Token"] = sess;
  }
  return headers;
}

/** 合并到 fetch init.headers（保留调用方已有头） */
export function mergeApiHeaders(init?: RequestInit): RequestInit {
  const base = getApiHeaders();
  const h = new Headers(init?.headers);
  for (const [k, v] of Object.entries(base)) {
    if (!h.has(k)) h.set(k, v);
  }
  return { ...init, headers: h };
}

/** 异步确保匿名用户已完成派生 ID，再合并请求头。 */
export async function mergeApiHeadersAsync(init?: RequestInit): Promise<RequestInit> {
  if (typeof window !== "undefined" && !getEffectiveUserIdSync()) {
    try {
      await ensureDerivedUserId();
    } catch {
      // 派生失败时保留现状，后端可回退到 IP+UA 推导。
    }
  }
  return mergeApiHeaders(init);
}
