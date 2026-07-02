"use client";

import { decodeProjectFileSelectValue } from "@/lib/chat-context";
export type FileRefState = "unselected" | "round" | "pinned" | "ai_suggested";

export type FileActionStatus = "proposed" | "applying" | "applied" | "rejected" | "failed";

export type PatchEditMode = "full" | "search_replace" | "line_range";

export type FileActionProposal =
  | {
      type: "create";
      proposalId: string;
      fileName: string;
      path: string;
      content: string;
      status: FileActionStatus;
      /** 最近一次 apply 失败时的错误信息（便于排查与重试） */
      applyError?: string;
    }
  | {
      type: "patch";
      proposalId: string;
      fileId: string;
      fileKind: "output" | "attachment";
      fileName: string;
      summary: string;
      before?: string;
      after: string;
      diff?: string;
      status: FileActionStatus;
      editMode?: PatchEditMode;
      oldString?: string;
      newString?: string;
      replaceAll?: boolean;
      startLine?: number;
      endLine?: number;
      newText?: string;
      /** 最近一次 apply 失败时的错误信息 */
      applyError?: string;
    };

export type FileRecommendation = {
  proposalId: string;
  fileId: string;
  fileKind: "output" | "attachment";
  fileName: string;
  reason: string;
};

export type CoCreateSaveState = "idle" | "saving" | "saved" | "error" | "pending_apply";
export type CoCreatePipeline = "fast" | "co_create" | "rewrite" | "research";
export type CoCreatePipelinePreference = "auto" | CoCreatePipeline;

export type { CoCreateAgentMode, CoCreateApplyMode, CoCreatePlanPhase } from "@/app/projects/[id]/co-create/co-create-agent-utils";

export function coCreatePipelineMeta(pipeline: CoCreatePipeline): {
  label: string;
  icon: string;
  description: string;
  badgeClassName: string;
} {
  switch (pipeline) {
    case "fast":
      return {
        label: "快速",
        icon: ">>",
        description: "直接生成首答，不检索文件",
        badgeClassName:
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200",
      };
    case "rewrite":
      return {
        label: "改写",
        icon: "~~",
        description: "将生成文件修改并自动写回",
        badgeClassName:
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200",
      };
    case "research":
      return {
        label: "研究",
        icon: "**",
        description: "正在进行深度检索与分析",
        badgeClassName:
          "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/70 dark:bg-violet-950/40 dark:text-violet-200",
      };
    case "co_create":
    default:
      return {
        label: "共创",
        icon: "∞",
        description: "结合项目上下文与知识库",
        badgeClassName:
          "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300",
      };
  }
}

export function coCreatePipelinePreferenceMeta(
  preference: CoCreatePipelinePreference,
  resolvedPipeline?: CoCreatePipeline,
): {
  label: string;
  icon: string;
  description: string;
  badgeClassName: string;
} {
  if (preference === "auto") {
    const resolved = resolvedPipeline ? coCreatePipelineMeta(resolvedPipeline) : null;
    return {
      label: "Auto",
      icon: "A",
      description: resolved
        ? `自动选择路径，当前命中：${resolved.label} · ${resolved.description}`
        : "自动选择路径",
      badgeClassName:
        "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800/70 dark:bg-blue-950/40 dark:text-blue-200",
    };
  }
  return coCreatePipelineMeta(preference);
}

/** 预览区选段加入对话框时的 payload */
export type SelectionToChatPayload = {
  text: string;
  startLine: number;
  endLine: number;
};

/** 对话框内展示的区域块引用（完整正文在发送时拼接） */
export type ContentRegionBlock = SelectionToChatPayload & {
  id: string;
  fileKey: string;
  fileName: string;
};

export function regionBlocksToExcerpts(blocks: ContentRegionBlock[]): Array<{
  fileName: string;
  startLine: number;
  endLine: number;
  text: string;
}> {
  return blocks.map(({ fileName, startLine, endLine, text }) => ({
    fileName,
    startLine,
    endLine,
    text,
  }));
}

export function formatRegionExcerptsForApi(
  excerpts: Array<{ fileName: string; startLine: number; endLine: number; text: string }>,
): string {
  return excerpts
    .map((b) => {
      const quoted = b.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `[${b.fileName} (${b.startLine}-${b.endLine})]\n${quoted}`;
    })
    .join("\n\n");
}

export function composeUserMessageForApi(
  userPrompt: string,
  excerpts: Array<{ fileName: string; startLine: number; endLine: number; text: string }>,
): string {
  const refs = formatRegionExcerptsForApi(excerpts);
  if (!userPrompt.trim()) return refs;
  if (!refs) return userPrompt.trim();
  return `${userPrompt.trim()}\n\n---\n\n${refs}`;
}

/** 查找当前预览文件对应的待确认 patch 提案（优先最新） */
export function findActivePatchProposal(
  activeFileKey: string | null,
  proposals: FileActionProposal[],
): Extract<FileActionProposal, { type: "patch" }> | null {
  if (!activeFileKey) return null;
  const decoded = decodeProjectFileSelectValue(activeFileKey);
  if (!decoded) return null;

  const matches = (p: FileActionProposal): p is Extract<FileActionProposal, { type: "patch" }> =>
    p.type === "patch" &&
    p.status === "proposed" &&
    p.fileId === decoded.id &&
    p.fileKind === decoded.kind;

  for (let i = proposals.length - 1; i >= 0; i -= 1) {
    const p = proposals[i];
    if (matches(p)) return p;
  }
  return null;
}

export type CoCreatePageState = {
  projectId: string;
  activeSessionId: string | null;
  pinnedFileIds: string[];
  roundFileIds: string[];
  previewFileId: string | null;
  pendingFileActions: FileActionProposal[];
  fileRecommendations: FileRecommendation[];
  streaming: boolean;
  saveState: CoCreateSaveState;
};
