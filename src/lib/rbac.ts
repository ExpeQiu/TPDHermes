/** 平台 Role 与功能入口权限（与 /me/access 对齐） */
import { apiGet, apiPut } from "./api";

export type PlatformRole = "platform_admin" | "tenant_admin" | "tenant_editor" | "tenant_partner";
export type FeatureKey =
  | "create"
  | "knowledge"
  | "skills"
  | "projects"
  | "chat"
  | "workshop"
  | "ops"
  | "settings";

export type ProjectRole = "owner" | "editor" | "viewer";

export interface UserAccessState {
  user_id: string;
  platform_role: PlatformRole;
  platform_role_label: string;
  features: FeatureKey[];
  is_global_admin: boolean;
  platform_roles: { id: PlatformRole; label: string }[];
  project_roles: { id: ProjectRole; label: string }[];
}

export const USER_ROLE_STORAGE_KEY = "tpdhermes_user_role";

const ACCESS_CACHE_KEY = "tpdhermes_user_access_cache";

export async function fetchUserAccess(): Promise<UserAccessState> {
  const data = await apiGet<UserAccessState>("/me/access");
  if (typeof window !== "undefined") {
    window.localStorage.setItem(USER_ROLE_STORAGE_KEY, data.platform_role);
    window.localStorage.setItem(ACCESS_CACHE_KEY, JSON.stringify(data));
  }
  return data;
}

export function loadCachedUserAccess(): UserAccessState | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ACCESS_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserAccessState;
  } catch {
    return null;
  }
}

export function clearCachedUserAccess(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACCESS_CACHE_KEY);
}

export function canAccessFeature(access: UserAccessState | null, feature: FeatureKey): boolean {
  if (!access) return feature === "settings" || feature === "projects" || feature === "chat" || feature === "workshop";
  return access.features.includes(feature);
}

export async function syncPlatformRoleToServer(platformRole: PlatformRole): Promise<UserAccessState> {
  await apiPut<{ ok: boolean; platform_role: PlatformRole }>("/me/role", {
    platform_role: platformRole,
  });
  return fetchUserAccess();
}

export const PLATFORM_ROLE_OPTIONS: { value: PlatformRole; label: string; hint: string }[] = [
  {
    value: "tenant_admin",
    label: "系统管理员",
    hint: "首页、项目中心，对话创作，场景输出，场景编排、知识库、技能工坊，运维，设置",
  },
  {
    value: "tenant_editor",
    label: "项目管理员",
    hint: "首页，项目中心，对话创作，场景输出，场景编排，知识库，技能工坊，设置",
  },
  {
    value: "tenant_partner",
    label: "项目成员",
    hint: "首页，项目中心，对话创作，场景输出，设置",
  },
  { value: "platform_admin", label: "平台管理员", hint: "全部功能（需全局管理员身份）" },
];

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
  owner: "负责人",
  editor: "编辑",
  viewer: "只读",
};

export function projectRoleLabel(role: string | null | undefined): string {
  const key = (role || "").trim() as ProjectRole;
  return PROJECT_ROLE_LABELS[key] || role || "成员";
}

export function projectRoleBadgeClass(role: string | null | undefined): string {
  switch ((role || "").trim()) {
    case "owner":
      return "border-violet-400/50 bg-violet-500/15 text-violet-800 dark:text-violet-200";
    case "editor":
      return "border-blue-400/50 bg-blue-500/15 text-blue-800 dark:text-blue-200";
    case "viewer":
      return "border-slate-400/50 bg-slate-500/15 text-slate-700 dark:text-slate-300";
    default:
      return "border-slate-400/50 bg-slate-500/10 text-slate-600 dark:text-slate-400";
  }
}

export const PROJECT_ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: "viewer", label: "只读" },
  { value: "editor", label: "编辑" },
  { value: "owner", label: "负责人" },
];
