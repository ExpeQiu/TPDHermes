"use client";

import { useEffect, useState } from "react";
import {
  USER_ID_STORAGE_KEY,
  ensureDerivedUserId,
  getEffectiveUserIdSync,
  hasStoredUserId,
} from "./user-id";

/** 与 API 头一致的有效用户 ID；随 localStorage / 匿名推导 / 焦点同步（多标签） */
export function useEffectiveUserScopeId(): string {
  const [userId, setUserId] = useState("");

  useEffect(() => {
    const sync = () => setUserId(getEffectiveUserIdSync());
    sync();
    window.addEventListener("focus", sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key === USER_ID_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    if (!hasStoredUserId()) {
      void ensureDerivedUserId()
        .then(() => sync())
        .catch(() => sync());
    }
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return userId;
}
