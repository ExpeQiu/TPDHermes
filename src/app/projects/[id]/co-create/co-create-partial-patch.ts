"use client";

import type { MessageRegionExcerpt } from "@/app/chat/chat-types";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";
import { computeLineDiff, type DiffLine } from "@/lib/text-line-diff";

export type PatchEditMode = "full" | "search_replace" | "line_range";

export function buildRegionAwarePatchInstructions(
  excerpts: Array<{ fileName: string; startLine: number; endLine: number; text: string }>,
): string {
  if (excerpts.length === 0) return "";
  const ranges = excerpts
    .map((e) => `${e.fileName} L${e.startLine}-${e.endLine}`)
    .join("、");
  return [
    "【局部改写约束】用户引用了文件选段，你必须优先做局部修改，禁止改动选段以外的无关段落。",
    `涉及范围：${ranges}。`,
    "同步到 TPDHermes 时，在 tphermes_file_actions 的 patch 动作中使用：",
    '1) editMode:"search_replace" + oldString（须与选段原文完全一致）+ newString；或',
    '2) editMode:"line_range" + startLine/endLine（与选段行号一致）+ newText。',
    "除非用户明确要求重写全文，否则不要使用 editMode:\"full\" 或仅提供整篇 after。",
    "可先用 Hermes patch(mode=replace) 在沙箱验证，再输出 tphermes_file_actions。",
  ].join(" ");
}

export function applySearchReplaceLocally(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string | null {
  if (!oldString || !content.includes(oldString)) return null;
  if (replaceAll) return content.replaceAll(oldString, newString);
  if (content.indexOf(oldString) !== content.lastIndexOf(oldString)) return null;
  return content.replace(oldString, newString);
}

export function applyLineRangeLocally(
  content: string,
  startLine: number,
  endLine: number,
  newText: string,
): string | null {
  if (startLine < 1 || endLine < startLine) return null;
  const lines = content.split("\n");
  if (endLine > lines.length) return null;
  const replacement = newText.split("\n");
  return [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(endLine)].join("\n");
}

export function resolvePatchAfterFromProposal(
  proposal: Extract<FileActionProposal, { type: "patch" }>,
  sourceContent: string,
): string {
  const mode = proposal.editMode ?? "full";
  if (mode === "search_replace" && proposal.oldString != null && proposal.newString != null) {
    const next = applySearchReplaceLocally(
      sourceContent,
      proposal.oldString,
      proposal.newString,
      proposal.replaceAll,
    );
    if (next != null) return next;
  }
  if (
    mode === "line_range" &&
    proposal.startLine != null &&
    proposal.endLine != null &&
    proposal.newText != null
  ) {
    const next = applyLineRangeLocally(
      sourceContent,
      proposal.startLine,
      proposal.endLine,
      proposal.newText,
    );
    if (next != null) return next;
  }
  return proposal.after || sourceContent;
}

export function patchEditModeLabel(mode?: PatchEditMode): string {
  switch (mode) {
    case "search_replace":
      return "局部替换";
    case "line_range":
      return "行范围改写";
    case "full":
    default:
      return "全文替换";
  }
}

/** 仅展示变更附近 ±contextLines 行的 diff */
export function focusDiffLines(lines: DiffLine[], contextLines = 3): DiffLine[] {
  const changeIndexes = lines
    .map((line, index) => (line.type !== "equal" ? index : -1))
    .filter((index) => index >= 0);
  if (changeIndexes.length === 0) return lines;
  const first = Math.max(0, (changeIndexes[0] ?? 0) - contextLines);
  const last = Math.min(lines.length - 1, (changeIndexes[changeIndexes.length - 1] ?? 0) + contextLines);
  const slice = lines.slice(first, last + 1);
  if (first > 0) {
    slice.unshift({ type: "equal", text: `…（省略前 ${first} 行）` });
  }
  if (last < lines.length - 1) {
    slice.push({ type: "equal", text: `…（省略后 ${lines.length - last - 1} 行）` });
  }
  return slice;
}

export function computeFocusedLineDiff(
  before: string,
  after: string,
  contextLines = 3,
): DiffLine[] {
  return focusDiffLines(computeLineDiff(before, after), contextLines);
}

export function regionExcerptsFromBlocks(
  blocks: Array<{ fileName: string; startLine: number; endLine: number; text: string }>,
): MessageRegionExcerpt[] {
  return blocks.map(({ fileName, startLine, endLine, text }) => ({
    fileName,
    startLine,
    endLine,
    text,
  }));
}
