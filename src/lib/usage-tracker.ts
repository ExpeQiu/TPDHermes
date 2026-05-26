"use client";

import { apiV1 } from "@/lib/api";
import { getEffectiveUserIdSync } from "@/lib/user-id";

type UsageEventInput = {
  eventName: string;
  feature: string;
  action: string;
  pagePath?: string;
  projectId?: string;
  properties?: Record<string, unknown>;
};

type UsageEventPayload = {
  event_name: string;
  feature: string;
  action: string;
  user_id?: string;
  session_id: string;
  page_path: string;
  project_id?: string;
  event_time: string;
  properties?: Record<string, unknown>;
};

const MAX_QUEUE_SIZE = 200;
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 20;
const SESSION_KEY = "tpdhermes_usage_session_id";
const warnedInvalidKeys = new Set<string>();

const FEATURE_ACTION_WHITELIST: Record<string, Set<string>> = {
  skills: new Set(["view", "toggle_click", "uninstall_click", "upload_select", "detail_view"]),
  skills_scope_panel: new Set(["select_skill"]),
  skills_package: new Set(["open_file", "save_file", "create_layout_item"]),
  projects: new Set(["detail_view", "switch_tab", "save_quick_scenarios"]),
  projects_outputs: new Set(["open_output", "approve_click", "archive_click"]),
  projects_attachments: new Set(["pick_click", "upload"]),
  chat_feedback: new Set(["thumbs_up", "thumbs_down", "adopt", "rewrite"]),
};

const queue: UsageEventPayload[] = [];
let flushTimer: number | null = null;
let listenersBound = false;
let flushing = false;

function nowIso() {
  return new Date().toISOString();
}

function validateUsageEvent(input: UsageEventInput): string | null {
  const feature = input.feature.trim();
  const action = input.action.trim();
  const eventName = input.eventName.trim();
  const expectedEventName = `${feature}_${action}`;
  if (!feature || !action || !eventName) {
    return "feature/action/eventName 不能为空";
  }
  const allowActions = FEATURE_ACTION_WHITELIST[feature];
  if (!allowActions) {
    return `feature 不在白名单: ${feature}`;
  }
  if (!allowActions.has(action)) {
    return `action 不在白名单: ${feature}.${action}`;
  }
  if (eventName !== expectedEventName) {
    return `eventName 与规范不一致，期望: ${expectedEventName}`;
  }
  return null;
}

function warnInvalidUsage(input: UsageEventInput, reason: string) {
  const key = `${input.eventName}|${input.feature}|${input.action}|${reason}`;
  if (warnedInvalidKeys.has(key)) return;
  warnedInvalidKeys.add(key);
  // 异步告警，避免阻塞页面交互主链路。
  window.setTimeout(() => {
    console.warn("[usage-tracker] 埋点白名单校验未通过，事件已丢弃", {
      reason,
      eventName: input.eventName,
      feature: input.feature,
      action: input.action,
      pagePath: input.pagePath || window.location.pathname,
    });
  }, 0);
}

function getSessionId(): string {
  if (typeof window === "undefined") return "server";
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  window.sessionStorage.setItem(SESSION_KEY, created);
  return created;
}

function enqueue(payload: UsageEventPayload) {
  queue.push(payload);
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushUsageEvents();
  }, FLUSH_INTERVAL_MS);
}

function bindLifecycleListeners() {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  const flushNow = () => {
    void flushUsageEvents(true);
  };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushNow();
    }
  });
}

async function sendWithFetch(events: UsageEventPayload[]) {
  await fetch(apiV1("/metrics/events"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive: true,
  });
}

function sendWithBeacon(events: UsageEventPayload[]) {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  const body = JSON.stringify({ events });
  const blob = new Blob([body], { type: "application/json" });
  return navigator.sendBeacon(apiV1("/metrics/events"), blob);
}

export async function flushUsageEvents(forceBeacon = false): Promise<void> {
  if (flushing || queue.length === 0 || typeof window === "undefined") return;
  flushing = true;
  const batch = queue.splice(0, FLUSH_BATCH_SIZE);
  try {
    if (!forceBeacon) {
      await sendWithFetch(batch);
      return;
    }
    const ok = sendWithBeacon(batch);
    if (!ok) await sendWithFetch(batch);
  } catch {
    queue.unshift(...batch);
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

export function trackUsage(input: UsageEventInput) {
  if (typeof window === "undefined") return;
  const invalidReason = validateUsageEvent(input);
  if (invalidReason) {
    warnInvalidUsage(input, invalidReason);
    return;
  }
  bindLifecycleListeners();
  const userId = getEffectiveUserIdSync().trim();
  enqueue({
    event_name: input.eventName,
    feature: input.feature,
    action: input.action,
    user_id: userId || undefined,
    session_id: getSessionId(),
    page_path: input.pagePath || window.location.pathname,
    project_id: input.projectId,
    event_time: nowIso(),
    properties: input.properties,
  });
  if (queue.length >= FLUSH_BATCH_SIZE) {
    void flushUsageEvents();
  } else {
    scheduleFlush();
  }
}
