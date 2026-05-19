"use client";

import { useEffect, useState } from "react";
import { USER_ID_STORAGE_KEY, loadUserIdFromStorage, normalizeUserId } from "./user-id";

/** 与 API 头一致的有效用户 ID；随 localStorage / 焦点同步（多标签） */
export function useEffectiveUserScopeId(): string {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const bump = () => setEpoch((e) => e + 1);
    window.addEventListener("focus", bump);
    const onStorage = (event: StorageEvent) => {
      if (event.key === USER_ID_STORAGE_KEY) bump();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  void epoch;
  return normalizeUserId(loadUserIdFromStorage() || "default");
}
