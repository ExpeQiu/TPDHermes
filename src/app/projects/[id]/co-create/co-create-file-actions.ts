"use client";

import { isAutoCreateFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-draft";
import { isAutoPatchFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-patch";
import { resolveUniqueOutputFileName } from "@/app/projects/[id]/co-create/co-create-output-naming";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

export const CREATE_APPLY_MIN_CONTENT_LEN = 80;

export const FILE_ACTIONS_FENCE_RE = /```tphermes_file_actions\s*\n[\s\S]*?```/gi;
const LOOSE_ACTIONS_JSON_FENCE_RE =
  /```(?:json|tphermes_file_actions)?\s*\n\s*\{\s*"actions"\s*:\s*\[[\s\S]*?```/gi;
const TRAILING_ACTIONS_FENCE_RE = /```tphermes_file_actions\s*\n[\s\S]*$/i;
const TRAILING_LOOSE_ACTIONS_RE = /```json\s*\n\s*\{\s*"actions"\s*:\s*\[[\s\S]*$/i;
/** 未闭合的 actions 代码块（流式截断） */
const UNCLOSED_ACTIONS_FENCE_RE =
  /```(?:tphermes_file_actions|json)?\s*\n\s*\{\s*"actions"\s*:\s*\[[\s\S]*$/i;
/** 裸露的 actions JSON（无 fence，常见于 Agent 误输出） */
const BARE_ACTIONS_JSON_RE = /\n?\{\s*"actions"\s*:\s*\[[\s\S]*$/;

/** 从对话展示正文中移除 tphermes_file_actions / 裸露 actions JSON */
export function stripFileActionsBlock(content: string): string {
  let next = (content || "").replace(FILE_ACTIONS_FENCE_RE, "").trim();
  next = next.replace(LOOSE_ACTIONS_JSON_FENCE_RE, "").trim();
  next = next.replace(TRAILING_ACTIONS_FENCE_RE, "").trim();
  next = next.replace(TRAILING_LOOSE_ACTIONS_RE, "").trim();
  next = next.replace(UNCLOSED_ACTIONS_FENCE_RE, "").trim();
  next = next.replace(BARE_ACTIONS_JSON_RE, "").trim();
  return next.replace(/\n{3,}/g, "\n\n").trim();
}

/** Hermes 沙箱绝对路径 → TPD 项目虚拟路径 */
export function normalizeCreateFilePath(fileName: string, rawPath?: string): string {
  const name = (fileName || "自动创建文稿.md").trim() || "自动创建文稿.md";
  const safeName = /\.md$/i.test(name) ? name : `${name}.md`;
  const path = (rawPath || "").trim();
  if (path.startsWith("/输出/")) return path;
  if (
    /^\/Users\//i.test(path) ||
    /^\/home\//i.test(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.includes(":\\")
  ) {
    return `/输出/${safeName}`;
  }
  if (path.startsWith("/") && !path.startsWith("/输出")) {
    return `/输出/${safeName}`;
  }
  if (!path || path === "/") {
    return `/输出/${safeName}`;
  }
  return `/输出/${safeName}`;
}

/** create 动作 content 过短时，从助手正文补全 */
export function resolveCreateActionContent(
  proposalContent: string,
  assistantContent: string,
  extractBody: (content: string) => string,
): string {
  const trimmed = (proposalContent || "").trim();
  if (trimmed.length >= 80) return trimmed;
  const fromBody = extractBody(assistantContent);
  if (fromBody.length >= 80) return fromBody;
  return trimmed || fromBody;
}

export function normalizeStreamCreateProposal(
  proposal: Extract<FileActionProposal, { type: "create" }>,
  assistantContent: string,
  extractBody: (content: string) => string,
  existingTitles: readonly string[] = [],
): Extract<FileActionProposal, { type: "create" }> {
  const rawName = proposal.fileName || "自动创建文稿.md";
  const fileName = resolveUniqueOutputFileName(rawName, existingTitles);
  return {
    ...proposal,
    fileName,
    path: `/输出/${fileName}`,
    content: resolveCreateActionContent(proposal.content, assistantContent, extractBody),
  };
}

export function isStreamFileActionProposal(proposalId: string): boolean {
  return !isAutoCreateFallbackProposal(proposalId) && !isAutoPatchFallbackProposal(proposalId);
}

export function hasActiveStreamFileActions(
  actions: FileActionProposal[] | undefined,
  isFallback: (id: string) => boolean = isStreamFileActionProposal,
): boolean {
  return (
    actions?.some(
      (item) =>
        !isFallback(item.proposalId) &&
        item.status !== "failed" &&
        item.status !== "rejected",
    ) ?? false
  );
}

/** create 提案是否已有足够正文可落库 */
export function isCreateProposalReadyForApply(
  proposalContent: string,
  assistantContent: string,
  extractBody: (content: string) => string,
): boolean {
  return (
    resolveCreateActionContent(proposalContent, assistantContent, extractBody).trim().length >=
    CREATE_APPLY_MIN_CONTENT_LEN
  );
}

export function upsertFileActionProposal(
  actions: FileActionProposal[],
  proposal: FileActionProposal,
): FileActionProposal[] {
  const index = actions.findIndex((item) => item.proposalId === proposal.proposalId);
  if (index === -1) return [...actions, proposal];
  const next = [...actions];
  next[index] = proposal;
  return next;
}

export function mergeFileActionProposals(
  ...lists: FileActionProposal[][]
): FileActionProposal[] {
  const map = new Map<string, FileActionProposal>();
  for (const list of lists) {
    for (const item of list) {
      map.set(item.proposalId, item);
    }
  }
  return dedupeCreateProposals([...map.values()]);
}

/** create 落库目标键：同项目虚拟路径 /输出/{fileName} */
export function createProposalTargetKey(proposal: FileActionProposal): string | null {
  if (proposal.type !== "create") return null;
  return normalizeCreateFilePath(proposal.fileName, proposal.path).toLowerCase();
}

const CREATE_STATUS_RANK: Record<FileActionProposal["status"], number> = {
  applied: 4,
  applying: 3,
  proposed: 2,
  failed: 1,
  rejected: 0,
};

/** 同一落库目标仅保留一条 create 提案（stream 优先于 fallback） */
export function dedupeCreateProposals(proposals: FileActionProposal[]): FileActionProposal[] {
  const byTarget = new Map<string, FileActionProposal>();
  const others: FileActionProposal[] = [];

  for (const proposal of proposals) {
    if (proposal.type !== "create") {
      others.push(proposal);
      continue;
    }
    const key = createProposalTargetKey(proposal) ?? proposal.proposalId;
    const prev = byTarget.get(key);
    if (!prev) {
      byTarget.set(key, proposal);
      continue;
    }
    const prevIsFallback = isAutoCreateFallbackProposal(prev.proposalId);
    const nextIsFallback = isAutoCreateFallbackProposal(proposal.proposalId);
    if (prevIsFallback && !nextIsFallback) {
      byTarget.set(key, proposal);
      continue;
    }
    if (!prevIsFallback && nextIsFallback) {
      continue;
    }
    const prevRank = CREATE_STATUS_RANK[prev.status] ?? 0;
    const nextRank = CREATE_STATUS_RANK[proposal.status] ?? 0;
    if (nextRank > prevRank) {
      byTarget.set(key, proposal);
    }
  }

  return [...others, ...byTarget.values()];
}

const CREATE_DISPLAY_RANK: Record<FileActionProposal["status"], number> = {
  proposed: 5,
  failed: 4,
  applying: 3,
  applied: 2,
  rejected: 0,
};

/** 展示用：同路径 create 仅保留一条，优先待用户确认的 proposed */
export function selectVisibleCreateProposals(
  proposals: FileActionProposal[],
): FileActionProposal[] {
  const byTarget = new Map<string, FileActionProposal>();
  const others: FileActionProposal[] = [];

  for (const proposal of proposals) {
    if (proposal.type !== "create") {
      others.push(proposal);
      continue;
    }
    const key = createProposalTargetKey(proposal) ?? proposal.proposalId;
    const prev = byTarget.get(key);
    if (!prev) {
      byTarget.set(key, proposal);
      continue;
    }
    const prevRank = CREATE_DISPLAY_RANK[prev.status] ?? 0;
    const nextRank = CREATE_DISPLAY_RANK[proposal.status] ?? 0;
    if (nextRank >= prevRank) {
      byTarget.set(key, proposal);
    }
  }

  return [...others, ...byTarget.values()];
}

/** 用户确认落库后，同路径其余 create 提案标记为 rejected */
export function rejectSiblingCreateProposals(
  proposals: FileActionProposal[],
  appliedProposalId: string,
): FileActionProposal[] {
  const applied = proposals.find((item) => item.proposalId === appliedProposalId);
  if (!applied || applied.type !== "create") return proposals;
  const target = createProposalTargetKey(applied);
  if (!target) return proposals;
  return proposals.map((item) => {
    if (
      item.type === "create" &&
      item.proposalId !== appliedProposalId &&
      createProposalTargetKey(item) === target
    ) {
      return { ...item, status: "rejected" as const };
    }
    return item;
  });
}

/** stream file_actions 到达时，清理同轮 pending 中的重复 create / fallback */
export function prunePendingCreatesForAssistantMessage(
  pending: FileActionProposal[],
  assistantId: string,
  incoming: FileActionProposal[],
): FileActionProposal[] {
  const incomingIds = new Set(incoming.map((item) => item.proposalId));
  const incomingCreateTargets = new Set(
    incoming
      .filter((item) => item.type === "create")
      .map((item) => createProposalTargetKey(item))
      .filter((key): key is string => Boolean(key)),
  );
  const fallbackId = `fallback-create:${assistantId}`;

  return pending.filter((item) => {
    if (incomingIds.has(item.proposalId)) return true;
    if (item.type !== "create") return true;
    if (item.proposalId === fallbackId) {
      return !incoming.some((next) => next.type === "create");
    }
    const target = createProposalTargetKey(item);
    if (target && incomingCreateTargets.has(target)) return false;
    return true;
  });
}

/** 本轮 assistant 是否已有 create 正在或已经落库 */
export function hasResolvedCreateForAssistant(
  actions: FileActionProposal[] | undefined,
): boolean {
  return (
    actions?.some(
      (item) =>
        item.type === "create" &&
        (item.status === "applied" || item.status === "applying"),
    ) ?? false
  );
}

/** 助手正文变长后，重新规范化 stream create 并在就绪时把 failed 重置为 proposed */
export function reconcileStreamCreateProposals(
  proposals: FileActionProposal[],
  assistantContent: string,
  extractBody: (content: string) => string,
  existingTitles: readonly string[] = [],
): FileActionProposal[] {
  return proposals.map((proposal) => {
    if (proposal.type !== "create" || isAutoCreateFallbackProposal(proposal.proposalId)) {
      return proposal;
    }
    if (
      proposal.status === "applied" ||
      proposal.status === "applying" ||
      proposal.status === "rejected"
    ) {
      return proposal;
    }
    const normalized = normalizeStreamCreateProposal(
      proposal,
      assistantContent,
      extractBody,
      existingTitles,
    );
    const ready = isCreateProposalReadyForApply(
      normalized.content,
      assistantContent,
      extractBody,
    );
    let status = proposal.status;
    if (proposal.status === "failed" && ready) {
      status = "proposed";
    } else if (proposal.status === "proposed" && !ready) {
      status = "proposed";
    }
    return {
      ...normalized,
      status,
      applyError: status === "proposed" ? undefined : proposal.applyError,
    };
  });
}

export function normalizeStreamPatchProposal(
  proposal: Extract<FileActionProposal, { type: "patch" }>,
  assistantContent: string,
  beforeContent: string,
  extractBody: (content: string) => string,
): Extract<FileActionProposal, { type: "patch" }> {
  let after = (proposal.after || "").trim();
  if (after.length < CREATE_APPLY_MIN_CONTENT_LEN) {
    after = extractBody(assistantContent).trim();
  }
  const before = (proposal.before || beforeContent || "").trim();
  return {
    ...proposal,
    before: before || undefined,
    after,
    editMode: proposal.editMode ?? "full",
  };
}

/** stream patch 正文补全后，将 failed 重置为 proposed 以便自动重试 */
export function reconcileStreamPatchProposals(
  proposals: FileActionProposal[],
  assistantContent: string,
  beforeContent: string,
  extractBody: (content: string) => string,
): FileActionProposal[] {
  return proposals.map((proposal) => {
    if (proposal.type !== "patch" || isAutoPatchFallbackProposal(proposal.proposalId)) {
      return proposal;
    }
    if (
      proposal.status === "applied" ||
      proposal.status === "applying" ||
      proposal.status === "rejected"
    ) {
      return proposal;
    }
    const normalized = normalizeStreamPatchProposal(
      proposal,
      assistantContent,
      beforeContent,
      extractBody,
    );
    const ready =
      normalized.after.trim().length >= CREATE_APPLY_MIN_CONTENT_LEN &&
      (!beforeContent.trim() || normalized.after.trim() !== beforeContent.trim());
    let status = proposal.status;
    if (proposal.status === "failed" && ready) {
      status = "proposed";
    }
    return {
      ...normalized,
      status,
      applyError: status === "proposed" ? undefined : proposal.applyError,
    };
  });
}
