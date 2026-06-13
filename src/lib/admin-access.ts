"use client";

import { useCallback, useEffect, useState } from "react";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import {
  canAccessFeature,
  fetchUserAccess,
  loadCachedUserAccess,
  type FeatureKey,
  type UserAccessState,
} from "@/lib/rbac";

export const ADMIN_USER_ID = "default";

/** 兼容旧逻辑：default 用户或 platform_admin */
export function isDefaultAdminUser(userId: string | null | undefined): boolean {
  return String(userId || "").trim() === ADMIN_USER_ID;
}

export function useUserAccess() {
  const userId = useEffectiveUserScopeId();
  const readyUser = userId.trim().length > 0;
  const [access, setAccess] = useState<UserAccessState | null>(() => loadCachedUserAccess());
  const [loading, setLoading] = useState(() => loadCachedUserAccess() === null);

  const refresh = useCallback(async () => {
    if (!readyUser) return null;
    try {
      const next = await fetchUserAccess();
      setAccess(next);
      return next;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [readyUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const canAccess = useCallback(
    (feature: FeatureKey) => {
      if (access) return canAccessFeature(access, feature);
      if (isDefaultAdminUser(userId)) return true;
      return canAccessFeature(null, feature);
    },
    [access, userId],
  );

  const isAdmin =
    Boolean(access?.is_global_admin) ||
    access?.platform_role === "platform_admin" ||
    isDefaultAdminUser(userId);

  const ready = readyUser && (access !== null || !loading);

  return { access, ready, loading, userId, isAdmin, canAccess, refresh };
}

/** @deprecated 使用 useUserAccess */
export function useIsDefaultAdmin(): { isAdmin: boolean; ready: boolean; userId: string } {
  const { isAdmin, ready, userId } = useUserAccess();
  return { isAdmin, ready, userId };
}
