"use client";

import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";

export const ADMIN_USER_ID = "default";

export function isDefaultAdminUser(userId: string | null | undefined): boolean {
  return String(userId || "").trim() === ADMIN_USER_ID;
}

export function useIsDefaultAdmin(): { isAdmin: boolean; ready: boolean; userId: string } {
  const userId = useEffectiveUserScopeId();
  const ready = userId.trim().length > 0;
  return { isAdmin: isDefaultAdminUser(userId), ready, userId };
}

