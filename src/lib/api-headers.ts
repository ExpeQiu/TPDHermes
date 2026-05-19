/**
 * 与后端 user_identity / RBAC 对齐：X-User-ID、X-User-Role、飞书会话。
 */
import {
  FEISHU_SESSION_STORAGE_KEY,
  USER_ID_STORAGE_KEY,
  loadFeishuSessionFromStorage,
  loadUserIdFromStorage,
  normalizeUserId,
} from "./user-id";

export const USER_ROLE_STORAGE_KEY = "tpdhermes_user_role";

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
  const userId = normalizeUserId(loadUserIdFromStorage().trim() || "default");
  const headers: Record<string, string> = {
    "X-User-ID": userId,
    "X-User-Role": loadUserRoleFromStorage(),
  };
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
