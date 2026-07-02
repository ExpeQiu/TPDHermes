"use client";

import type { ProjectFileKind } from "@/lib/chat-context";
import { CO_CREATE_OUTPUT_WRITE_POLICY } from "@/app/projects/[id]/co-create/co-create-file-policy";
import {
  extractAutoCreateDraftBody,
  isDocumentGenerationPrompt,
} from "@/app/projects/[id]/co-create/co-create-auto-draft";

const REWRITE_PROMPT_RE =
  /\/改写当前文件|修改|改写|重写|润色|扩写|扩展|精简|压缩|优化|完善|调整/i;

/** 已引用文件时的增补/编辑意图（短指令常见） */
const EDIT_WITH_FILE_RE =
  /增加|补充|加入|添加|融入|插入|丰富|深化|加强|删掉|删除|去掉|改成|换成|强调|突出|继续|再写|对标|洞察|用户视角|竞品|生动|口语|正式|专业/i;

const ASK_ONLY_PROMPT_RE =
  /^(什么|为什么|怎么|如何|是否|能否|请问|解释|解读|分析|介绍|说明|讲讲|说说)/;

const MIN_PATCH_BODY_LEN = 80;
const MIN_PATCH_GROWTH = 40;

export type AutoPatchTargetFile = {
  fileKey: string;
  fileId: string;
  fileKind: ProjectFileKind;
  fileName: string;
};

export type RewritePromptOptions = {
  /** 本轮是否已引用 round/pinned 文件 */
  hasTargetFile?: boolean;
};

export function isRewritePrompt(prompt: string, options?: RewritePromptOptions): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  if (normalized.startsWith("/生成新文件")) return false;
  if (isDocumentGenerationPrompt(normalized)) return false;

  const compact = normalized.replace(/\s+/g, "");
  if (REWRITE_PROMPT_RE.test(compact)) return true;

  const hasTargetFile = options?.hasTargetFile ?? false;
  if (!hasTargetFile) return false;
  if (ASK_ONLY_PROMPT_RE.test(compact)) return false;
  if (EDIT_WITH_FILE_RE.test(compact)) return true;
  // 短指令 + 已引用文件：默认视为在当前稿上改写（非新建文稿）
  if (compact.length <= 48 && /一些|一点|部分|段落|章节|开头|结尾|第二|这段|那段/.test(compact)) {
    return true;
  }
  return false;
}

export function buildRewriteSyncInstructions(
  prompt: string,
  hasTargetFile: boolean,
): string {
  if (!isRewritePrompt(prompt, { hasTargetFile }) || !hasTargetFile) return "";
  return [
    "【改写同步】用户要求润色/改写/扩展当前引用文件，必须写回项目文件。",
    "正文须完整写在回复中；末尾附加 ```tphermes_file_actions``` 的 patch 动作。",
    "整篇改写用 editMode=full，content/after 为改写后全文；局部改写用 search_replace 或 line_range。",
    "patch 须包含 target_file_id（或 fileId）、file_kind=output、file_name；勿只给口头建议。",
    CO_CREATE_OUTPUT_WRITE_POLICY,
  ].join(" ");
}

/** 从助手回复提取可落库的改写正文 */
export function extractAutoPatchBody(content: string): string {
  return extractAutoCreateDraftBody(content);
}

export function isReadyForAutoPatch(
  after: string,
  before: string,
  rawAssistantContent: string,
): boolean {
  const next = after.trim();
  const prev = before.trim();
  if (!next || next.length < MIN_PATCH_BODY_LEN) return false;
  if (prev && next === prev) return false;
  if (prev && Math.abs(next.length - prev.length) < MIN_PATCH_GROWTH && next.slice(0, 120) === prev.slice(0, 120)) {
    return false;
  }
  if (rawAssistantContent.length > 200 && next.length < 120) return false;
  return true;
}

export function shouldAutoPatchFromAssistant(
  prompt: string,
  assistantContent: string,
  beforeContent: string,
  hasExistingFileActions = false,
  hasTargetFile = true,
): boolean {
  if (hasExistingFileActions) return false;
  if (!isRewritePrompt(prompt, { hasTargetFile })) return false;
  const after = extractAutoPatchBody(assistantContent);
  return isReadyForAutoPatch(after, beforeContent, assistantContent);
}

export function isAutoPatchFallbackProposal(proposalId: string): boolean {
  return proposalId.startsWith("fallback-patch:");
}

export function autoPatchFallbackProposalId(assistantId: string): string {
  return `fallback-patch:${assistantId}`;
}

export function inferAutoPatchSummary(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 48) return compact || "自动同步改写";
  return `${compact.slice(0, 45)}…`;
}
