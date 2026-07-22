"use client";

import { useCallback, useEffect, useState } from "react";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import {
  canAccessFeature,
  clearCachedUserAccess,
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

function accessForUser(userId: string): UserAccessState | null {
  const cached = loadCachedUserAccess();
  if (!cached) return null;
  if (cached.user_id && cached.user_id !== userId) {
    clearCachedUserAccess();
    return null;
  }
  return cached;
}

export function useUserAccess() {
  const userId = useEffectiveUserScopeId();
  const readyUser = userId.trim().length > 0;
  const [access, setAccess] = useState<UserAccessState | null>(() =>
    readyUser ? accessForUser(userId) : null,
  );
  const [loading, setLoading] = useState(() =>
    readyUser ? accessForUser(userId) === null : true,
  );

  const refresh = useCallback(async () => {
    if (!readyUser) return null;
    setLoading(true);
    try {
      const next = await fetchUserAccess();
      setAccess(next);
      return next;
    } catch {
      setAccess((prev) => {
        if (prev?.user_id && prev.user_id !== userId) return null;
        return prev;
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [readyUser, userId]);

  useEffect(() => {
    const matched = accessForUser(userId);
    setAccess(matched);
    setLoading(matched === null);
    void refresh();
  }, [refresh, userId]);

  const canAccess = useCallback(
    (feature: FeatureKey) => {
      if (access && access.user_id && access.user_id !== userId) {
        return canAccessFeature(null, feature);
      }
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
