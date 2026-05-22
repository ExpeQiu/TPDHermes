"use client";

import { useEffect } from "react";
import { ensureDerivedUserId, hasStoredUserId } from "@/lib/user-id";

/** 应用启动时预拉取 IP+UA 匿名 user_id（无本地保存时） */
export function UserIdentityInit() {
  useEffect(() => {
    if (!hasStoredUserId()) void ensureDerivedUserId();
  }, []);
  return null;
}
