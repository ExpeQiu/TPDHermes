"use client";

import { useEffect, useState } from "react";
import {
  USER_ID_STORAGE_KEY,
  ensureDerivedUserId,
  getEffectiveUserIdSync,
  hasStoredUserId,
} from "./user-id";
import { adoptServerUnifiedUserIdIfNeeded } from "./user-identity-sync";

/** 与 API 头一致的有效用户 ID；随 localStorage / 匿名推导 / 焦点同步（多标签） */
export function useEffectiveUserScopeId(): string {
  const [userId, setUserId] = useState("");

  useEffect(() => {
    const sync = () => setUserId(getEffectiveUserIdSync());
    const bootstrap = async () => {
      await adoptServerUnifiedUserIdIfNeeded();
      if (!hasStoredUserId()) {
        try {
          await ensureDerivedUserId();
        } catch {
          /* 派生失败时后端仍可回退 */
        }
      }
      sync();
    };
    void bootstrap();
    window.addEventListener("focus", sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key === USER_ID_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return userId;
}
