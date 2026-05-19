/** localStorage：用户隔离 ID（与设置页、API 头共享） */
export const USER_ID_STORAGE_KEY = "tpdhermes_user_id";

export const FEISHU_SESSION_STORAGE_KEY = "tpdhermes_feishu_session";

/** 与 X-User-ID 一致：空串归一为 default */
export function normalizeUserId(value: string): string {
  return value.trim() || "default";
}

export function loadUserIdFromStorage(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(USER_ID_STORAGE_KEY)?.trim() || "";
}

export function loadFeishuSessionFromStorage(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(FEISHU_SESSION_STORAGE_KEY)?.trim() || "";
}
