"use client";

import { isAutoCreateFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-draft";
import { isAutoPatchFallbackProposal } from "@/app/projects/[id]/co-create/co-create-auto-patch";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

export const CREATE_APPLY_MIN_CONTENT_LEN = 80;

export const FILE_ACTIONS_FENCE_RE = /```tphermes_file_actions\s*\n[\s\S]*?```/gi;
const LOOSE_ACTIONS_JSON_FENCE_RE =
  /```(?:json|tphermes_file_actions)?\s*\n\s*\{\s*"actions"\s*:\s*\[[\s\S]*?```/gi;
const TRAILING_ACTIONS_FENCE_RE = /```tphermes_file_actions\s*\n[\s\S]*$/i;
const TRAILING_LOOSE_ACTIONS_RE = /```json\s*\n\s*\{\s*"actions"\s*:\s*\[[\s\S]*$/i;

/** 从对话展示正文中移除 tphermes_file_actions / 裸露 actions JSON */
export function stripFileActionsBlock(content: string): string {
  let next = (content || "").replace(FILE_ACTIONS_FENCE_RE, "").trim();
  next = next.replace(LOOSE_ACTIONS_JSON_FENCE_RE, "").trim();
  next = next.replace(TRAILING_ACTIONS_FENCE_RE, "").trim();
  next = next.replace(TRAILING_LOOSE_ACTIONS_RE, "").trim();
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
): Extract<FileActionProposal, { type: "create" }> {
  const fileName = proposal.fileName || "自动创建文稿.md";
  return {
    ...proposal,
    fileName,
    path: normalizeCreateFilePath(fileName, proposal.path),
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
    const normalized = normalizeStreamCreateProposal(proposal, assistantContent, extractBody);
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
