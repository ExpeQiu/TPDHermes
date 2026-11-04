/** 本机账号会话：顶栏注册 / 登录 / 退出。 */
import { apiGet, apiPost } from "./api";
import { clearCachedUserAccess } from "./rbac";
import {
  FEISHU_SESSION_STORAGE_KEY,
  LOCAL_SESSION_STORAGE_KEY,
  USER_ID_STORAGE_KEY,
  loadLocalSessionToken,
  normalizeUserId,
} from "./user-id";

export { LOCAL_SESSION_STORAGE_KEY, loadLocalSessionToken };
export const LOCAL_PROFILE_STORAGE_KEY = "tpdhermes_local_profile";
export const USER_CHANGED_EVENT = "tpdhermes-user-changed";

export type LocalAccountProfile = {
  user_id: string;
  username: string;
  display_name: string;
  employee_id: string;
  org_id: string;
  platform_role_label?: string;
  avatar_initial: string;
};

type SessionResponse = LocalAccountProfile & {
  ok?: boolean;
  token?: string;
  platform_role_label?: string;
};

export function loadLocalProfile(): LocalAccountProfile | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LOCAL_PROFILE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LocalAccountProfile;
    if (!parsed?.user_id || !parsed.username) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistSession(profile: LocalAccountProfile, token: string) {
  window.localStorage.setItem(LOCAL_SESSION_STORAGE_KEY, token);
  window.localStorage.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  window.localStorage.setItem(USER_ID_STORAGE_KEY, normalizeUserId(profile.user_id));
  window.localStorage.removeItem(FEISHU_SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(FEISHU_SESSION_STORAGE_KEY);
  clearCachedUserAccess();
  window.dispatchEvent(new Event(USER_CHANGED_EVENT));
  console.info("[local-auth] 已切换用户", {
    username: profile.username,
    user_id: profile.user_id,
  });
}

export function clearLocalSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LOCAL_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(LOCAL_PROFILE_STORAGE_KEY);
  window.localStorage.removeItem(USER_ID_STORAGE_KEY);
  window.localStorage.removeItem(FEISHU_SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(FEISHU_SESSION_STORAGE_KEY);
  clearCachedUserAccess();
  window.dispatchEvent(new Event(USER_CHANGED_EVENT));
  console.info("[local-auth] 已退出登录");
}

function profileOf(data: SessionResponse): LocalAccountProfile {
  return {
    user_id: data.user_id,
    username: data.username,
    display_name: data.display_name,
    employee_id: data.employee_id || "",
    org_id: data.org_id || "",
    platform_role_label: data.platform_role_label,
    avatar_initial: data.avatar_initial || data.display_name.slice(0, 1).toUpperCase() || "U",
  };
}

export const DEFAULT_INITIAL_PASSWORD = "geely123";

export async function registerLocalAccount(input: {
  username: string;
  employee_id: string;
  org_id: string;
  password?: string;
}): Promise<LocalAccountProfile> {
  const data = await apiPost<SessionResponse>("/auth/register", {
    username: input.username.trim(),
    employee_id: input.employee_id.trim(),
    org_id: input.org_id.trim(),
    password: input.password?.trim() || DEFAULT_INITIAL_PASSWORD,
  });
  if (!data.token) throw new Error("注册成功但未返回会话");
  const profile = profileOf(data);
  persistSession(profile, data.token);
  return profile;
}

export async function loginLocalAccount(input: {
  username: string;
  password: string;
}): Promise<LocalAccountProfile> {
  const data = await apiPost<SessionResponse>("/auth/login", {
    username: input.username.trim(),
    password: input.password,
  });
  if (!data.token) throw new Error("登录成功但未返回会话");
  const profile = profileOf(data);
  persistSession(profile, data.token);
  return profile;
}

export async function fetchLocalSession(): Promise<LocalAccountProfile | null> {
  if (!loadLocalSessionToken()) return null;
  try {
    const data = await apiGet<SessionResponse>("/auth/session");
    const profile = profileOf(data);
    window.localStorage.setItem(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    return profile;
  } catch (err) {
    console.warn("[local-auth] 会话已失效", err);
    clearLocalSession();
    return null;
  }
}

export async function logoutLocalAccount(): Promise<void> {
  try {
    if (loadLocalSessionToken()) {
      await apiPost<{ ok: boolean }>("/auth/logout", {});
    }
  } catch (err) {
    console.warn("[local-auth] 退出请求失败，仍清除本机会话", err);
  }
  clearLocalSession();
}

export function reloadAfterAuth(): void {
  window.location.reload();
}
