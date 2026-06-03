/** 跨设备统一 User ID：与服务端 /me/identity 同步 */
import { apiGet, apiPost, apiPut } from "./api";
import {
  USER_ID_STORAGE_KEY,
  loadUserIdFromStorage,
  normalizeUserId,
} from "./user-id";

export interface UserIdentityState {
  effective_user_id: string;
  unified_user_id: string;
  feishu_bound: boolean;
  source: "feishu" | "custom" | "anonymous";
}

export async function fetchServerIdentity(): Promise<UserIdentityState> {
  return apiGet<UserIdentityState>("/me/identity");
}

export async function syncUnifiedUserIdToServer(unifiedUserId: string): Promise<UserIdentityState> {
  await apiPut<{ ok: boolean; unified_user_id: string }>("/me/identity", {
    unified_user_id: unifiedUserId,
  });
  return fetchServerIdentity();
}

export async function generateUnifiedUserId(): Promise<string> {
  const data = await apiPost<{ unified_user_id: string }>("/me/identity/generate", {});
  return (data.unified_user_id || "").trim();
}

/** 启动时：若本机未保存 User ID，尝试采用服务端统一 ID（飞书或曾同步的自定义 ID） */
export async function adoptServerUnifiedUserIdIfNeeded(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const local = loadUserIdFromStorage();
  if (local) return local;
  try {
    const identity = await fetchServerIdentity();
    const unified = (identity.unified_user_id || "").trim();
    if (!unified || unified.startsWith("auto_")) return null;
    window.localStorage.setItem(USER_ID_STORAGE_KEY, normalizeUserId(unified));
    console.info("[identity] 已采用服务端统一 User ID", unified.slice(0, 24));
    return unified;
  } catch (err) {
    console.warn("[identity] 拉取服务端身份失败", err);
    return null;
  }
}

export function saveUnifiedUserIdLocally(unifiedUserId: string): string {
  if (typeof window === "undefined") return unifiedUserId;
  const normalized = normalizeUserId(unifiedUserId.trim());
  window.localStorage.setItem(USER_ID_STORAGE_KEY, normalized);
  return normalized;
}
