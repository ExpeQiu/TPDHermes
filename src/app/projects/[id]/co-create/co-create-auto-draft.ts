"use client";

import type { Message } from "@/app/chat/chat-types";
import { stripFileActionsBlock } from "@/app/projects/[id]/co-create/co-create-file-actions";
import {
  buildExistingOutputNamesHint,
  resolveUniqueOutputFileName,
} from "@/app/projects/[id]/co-create/co-create-output-naming";
import { CO_CREATE_OUTPUT_WRITE_POLICY } from "@/app/projects/[id]/co-create/co-create-file-policy";
import { unwrapSkillAssistantMarkdown } from "@/lib/skill-output";

const SINGLE_MARKDOWN_BLOCK_RE = /^```(?:markdown|md|mdx)?\s*\n([\s\S]*?)\n```$/i;
const MARKDOWN_TITLE_RE = /^\s*#\s+(.+?)\s*$/m;

const CO_CREATE_AUTO_CREATE_VERB_RE = /\/生成新文件|生成|创建|新建|起草|撰写|写|输出/i;
const DOC_NOUN_RE =
  /文稿|文档|稿件|报告|方案|说明|文章|PRD|需求文档|汇报|总结|脚本|纪要|提案|计划|演讲稿|讲话稿|发言稿|讲稿|发布会稿|新闻稿|通稿|主持稿|稿/i;
const CO_CREATE_AUTO_CREATE_NOUN_RE = DOC_NOUN_RE;

const PLAIN_DOC_TITLE_RE =
  /^([^\n#]{2,80}?(?:演讲稿|讲话稿|发言稿|讲稿|发布会稿|新闻稿|通稿|主持稿|文稿|文档|方案|报告|纪要|脚本|提案|计划|总结|汇报))\s*$/m;

const DRAFT_START_MARKER_RE =
  /(?:^|\n)(?:[^\n]{0,48}(?:开始撰写|撰写如下|撰写完整)[^\n]*|(?:正文|文稿|演讲稿|文档)如下)[：:]*\s*\n+/i;

/** Agent 过程旁白行（检索、素材罗列、过渡语） */
const PREAMBLE_LINE_RE =
  /^(?:先|正在|开始)?(?:检索|搜集|查阅|获取|搜索|整理)|信息检索完毕|核心素材|素材包括|现在撰写|稿已完成|基于搜索|确保内容有据/i;

const MIN_DRAFT_BODY_WITH_TITLE = 300;
const MIN_DRAFT_BODY_WITHOUT_TITLE = 900;
const MIN_QUICK_START_BODY_WITH_TITLE = 120;
const MIN_QUICK_START_BODY_PLAIN = 150;

export function normalizeAutoCreateDraftContent(content: string): string {
  let next = unwrapSkillAssistantMarkdown(content);
  next = stripFileActionsBlock(next);
  const fenced = next.match(SINGLE_MARKDOWN_BLOCK_RE);
  if (fenced?.[1]) next = fenced[1].trim();
  return next;
}

function hasDocumentTitle(content: string): boolean {
  return MARKDOWN_TITLE_RE.test(content) || PLAIN_DOC_TITLE_RE.test(content);
}

function isLikelyDraftContent(content: string): boolean {
  if (!content.trim()) return false;
  if (content.length >= 200) return true;
  if (MARKDOWN_TITLE_RE.test(content)) return true;
  const nonEmptyLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length >= 6;
}

function sanitizeDraftFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "自动创建文稿";
}

function inferDraftTitleFromPrompt(prompt: string): string | null {
  const compact = prompt.replace(/\s+/g, "");
  const explicit = compact.match(
    /(?:生成|创建|新建|起草|撰写|写|输出)(?:一篇|一个|一份|一版|篇|份|个|版)?(?:新)?(.{2,48}?(?:演讲稿|讲话稿|发言稿|讲稿|发布会稿|新闻稿|通稿|主持稿|文稿|文档|稿件|报告|方案|说明|文章|PRD|需求文档|汇报|总结|脚本|纪要|提案|计划|稿))/i,
  );
  if (explicit?.[1]) return explicit[1];
  return null;
}

function pickBestTitleSection(body: string): string {
  const titlePattern = new RegExp(PLAIN_DOC_TITLE_RE.source, "gm");
  const matches = [...body.matchAll(titlePattern)];
  if (matches.length === 0) return body;

  let best = body;
  let bestLen = 0;
  for (const match of matches) {
    if (match.index === undefined) continue;
    const slice = body.slice(match.index).trim();
    if (slice.length > bestLen) {
      bestLen = slice.length;
      best = slice;
    }
  }
  return best;
}

function stripLeadingProcessLines(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start]?.trim() ?? "";
    if (!line) {
      start += 1;
      continue;
    }
    if (PREAMBLE_LINE_RE.test(line)) {
      start += 1;
      continue;
    }
    if (/^[-*•]\s/.test(line) && start < 12) {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n").trim();
}

/** 去掉 Agent 检索/思考前言，保留正文起点 */
export function extractAutoCreateDraftBody(content: string): string {
  let body = normalizeAutoCreateDraftContent(content);
  if (!body) return "";

  const markdownHeading = body.match(MARKDOWN_TITLE_RE);
  if (markdownHeading?.index !== undefined && markdownHeading.index > 0) {
    const preamble = body.slice(0, markdownHeading.index).trim();
    if (preamble.length > 20) {
      body = body.slice(markdownHeading.index).trim();
    }
  }

  const startMarker = body.match(DRAFT_START_MARKER_RE);
  if (startMarker?.index !== undefined) {
    const sliced = body.slice(startMarker.index + startMarker[0].length).trim();
    if (sliced.length >= 80) body = sliced;
  }

  body = pickBestTitleSection(body);

  const plainTitle = body.match(PLAIN_DOC_TITLE_RE);
  if (plainTitle?.index !== undefined && plainTitle.index > 0) {
    const preamble = body.slice(0, plainTitle.index).trim();
    if (preamble.length > 30) {
      body = body.slice(plainTitle.index).trim();
    }
  }

  body = stripLeadingProcessLines(body);

  // 去掉末尾「稿已完成」类收束语之后若几乎无正文
  body = body.replace(/\n[^\n]{0,24}稿已完成[，,。.!！]?\s*$/u, "").trim();

  return body.trim();
}

/** 正文是否已足够完整，可落库（避免仅前言就建稿） */
export function isReadyForAutoCreateDraft(extracted: string, rawContent: string): boolean {
  const body = extracted.trim();
  if (!body) return false;

  const titled = hasDocumentTitle(body);
  if (titled && body.length >= MIN_DRAFT_BODY_WITH_TITLE) return true;
  if (!titled && body.length >= MIN_DRAFT_BODY_WITHOUT_TITLE) return true;

  // 仅有过程旁白、尚无标题正文
  if (
    /先检索|信息检索完毕|现在撰写|稿已完成|核心素材/.test(body) &&
    !titled &&
    body.length < MIN_DRAFT_BODY_WITHOUT_TITLE
  ) {
    return false;
  }

  // 原始很长但提取后仍像前言
  if (rawContent.length > 400 && !titled && body.length < 500) {
    return false;
  }

  return isLikelyDraftContent(body);
}

/** 快捷创作场景：技能标准输出物阈值低于长文 Agent 稿 */
export function isReadyForQuickStartAutoCreateDraft(
  extracted: string,
  rawContent: string,
): boolean {
  const body = extracted.trim();
  if (!body) return false;
  const titled = hasDocumentTitle(body);
  if (titled && body.length >= MIN_QUICK_START_BODY_WITH_TITLE) return true;
  if (body.length >= MIN_QUICK_START_BODY_PLAIN) return true;
  return isReadyForAutoCreateDraft(extracted, rawContent);
}

export function isDocumentGenerationPrompt(prompt: string): boolean {
  const normalized = prompt.trim();
  if (!normalized) return false;
  if (normalized.startsWith("/生成新文件")) return true;
  if (CO_CREATE_AUTO_CREATE_VERB_RE.test(normalized) && CO_CREATE_AUTO_CREATE_NOUN_RE.test(normalized)) {
    return true;
  }
  return /(?:撰写|写|起草|生成|输出).{0,32}(?:稿|说明|文档|方案)/.test(
    normalized.replace(/\s+/g, ""),
  );
}

export function buildQuickStartOutputSyncInstructions(
  entryTitle: string,
  prompt: string,
  existingTitles: readonly string[] = [],
): string {
  const title = entryTitle.trim();
  if (!title) return buildDocumentSyncInstructions(prompt, existingTitles);
  const fileName = inferQuickCreateOutputFileName(title, prompt, "", existingTitles);
  const quickHint = [
    "【快捷创作标准输出】本轮为场景快捷创作，须产出可沉淀至项目文件库的标准输出物。",
    `优先保存为 /输出/${fileName}（与场景「${title}」对应）。`,
    "正文须完整写在回复中；末尾附加 ```tphermes_file_actions``` create 动作，",
    "create 的 path 必须为 `/输出/{fileName}`，禁止使用本机绝对路径。",
  ].join(" ");
  const docSync = buildDocumentSyncInstructions(prompt, existingTitles);
  return [docSync, quickHint].filter(Boolean).join("\n\n");
}

export function buildDocumentSyncInstructions(
  prompt: string,
  existingTitles: readonly string[] = [],
): string {
  if (!isDocumentGenerationPrompt(prompt)) return "";
  const namingHint = buildExistingOutputNamesHint(existingTitles);
  return [
    "【文稿同步】用户本轮要求生成完整文稿（演讲稿、发布会稿、新闻稿、方案、报告等）。",
    "正文须先完整写在回复正文中；末尾附加 ```tphermes_file_actions``` 的 create 动作。",
    "create 的 path 必须为 `/输出/{fileName}`（项目虚拟路径，落库 outputs 表并在右侧「输出物」展示），禁止使用 /Users、/home 或本机绝对路径。",
    CO_CREATE_OUTPUT_WRITE_POLICY,
    "若 JSON 的 content 字段过长易截断，可仅写 fileName+path，content 与正文一致且须为合法 JSON 字符串；",
    "勿等用户再次要求「整理成文档」。",
    namingHint,
  ]
    .filter(Boolean)
    .join(" ");
}

export function inferQuickCreateOutputFileName(
  entryTitle: string,
  prompt: string,
  content: string,
  existingTitles: readonly string[] = [],
): string {
  const fromEntry = sanitizeDraftFileName(entryTitle.trim());
  if (fromEntry && fromEntry !== "自动创建文稿") {
    return resolveUniqueOutputFileName(fromEntry, existingTitles);
  }
  return inferAutoCreateDraftFileName(prompt, content, existingTitles);
}

export function inferAutoCreateDraftFileName(
  prompt: string,
  content: string,
  existingTitles: readonly string[] = [],
): string {
  const normalizedContent = extractAutoCreateDraftBody(content);
  const heading = normalizedContent.match(MARKDOWN_TITLE_RE)?.[1]?.trim();
  const plainTitle = normalizedContent.match(PLAIN_DOC_TITLE_RE)?.[1]?.trim();
  const title = sanitizeDraftFileName(
    heading || plainTitle || inferDraftTitleFromPrompt(prompt) || "自动创建文稿",
  );
  return resolveUniqueOutputFileName(title, existingTitles);
}

export function shouldAutoCreateDraftFromAssistant(
  prompt: string,
  assistantContent: string,
  hasExistingFileActions = false,
): boolean {
  if (hasExistingFileActions) return false;
  if (!isDocumentGenerationPrompt(prompt)) return false;
  const extracted = extractAutoCreateDraftBody(assistantContent);
  return isReadyForAutoCreateDraft(extracted, assistantContent);
}

export function shouldQuickStartAutoCreateDraft(
  entryTitle: string,
  prompt: string,
  assistantContent: string,
  hasExistingFileActions = false,
): boolean {
  if (hasExistingFileActions) return false;
  if (!entryTitle.trim()) return false;
  const extracted = extractAutoCreateDraftBody(assistantContent);
  return isReadyForQuickStartAutoCreateDraft(extracted, assistantContent);
}

export function isAutoCreateFallbackProposal(proposalId: string): boolean {
  return proposalId.startsWith("fallback-create:");
}

export function autoCreateFallbackProposalId(assistantId: string): string {
  return `fallback-create:${assistantId}`;
}

/** 取最近一轮 assistant 回复对应的用户 prompt */
export function findLatestTurnUserPrompt(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    for (let j = i - 1; j >= 0; j--) {
      const user = messages[j];
      if (user?.role === "user") {
        return user.userPrompt?.trim() || user.content?.trim() || "";
      }
    }
    return "";
  }
  return "";
}
