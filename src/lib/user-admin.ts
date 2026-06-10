import { apiGet, apiPut } from "./api";
import type { PlatformRole } from "./rbac";

export interface ManagedUserRow {
  user_id: string;
  unified_user_id: string;
  display_name: string;
  avatar_initial: string;
  platform_role: PlatformRole | null;
  platform_role_label: string | null;
  resolved_platform_role: PlatformRole;
  resolved_platform_role_label: string;
}

export async function fetchManagedUsers(): Promise<ManagedUserRow[]> {
  return apiGet<ManagedUserRow[]>("/me/managed-users");
}

export async function assignUserPlatformRole(
  userId: string,
  platformRole: PlatformRole,
): Promise<{ ok: boolean; platform_role: PlatformRole }> {
  return apiPut(`/me/managed-users/${encodeURIComponent(userId)}/role`, {
    platform_role: platformRole,
  });
}

/** 系统管理员 / 平台管理员可见用户分组管理 */
export function isSystemAdminRole(platformRole: string | null | undefined): boolean {
  return platformRole === "tenant_admin" || platformRole === "platform_admin";
}
