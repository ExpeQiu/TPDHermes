"use client";

import { decodeProjectFileSelectValue } from "@/lib/chat-context";
import { fetchProjectFileDetail, type ProjectFileItem } from "@/lib/co-create-api";
import { randomUUID } from "@/lib/random-id";
import type { Message } from "@/app/chat/chat-types";
import type {
  CoCreatePipeline,
  FileActionProposal,
  PatchEditMode,
} from "@/app/projects/[id]/co-create/co-create-types";
import { isCoCreateWritableFileKind } from "@/app/projects/[id]/co-create/co-create-file-policy";
import {
  isRewritePrompt,
  type AutoPatchTargetFile,
} from "@/app/projects/[id]/co-create/co-create-auto-patch";
import { isDocumentGenerationPrompt } from "@/app/projects/[id]/co-create/co-create-auto-draft";
import { normalizeCreateFilePath } from "@/app/projects/[id]/co-create/co-create-file-actions";

export function decodeFileIds(keys: string[]): string[] {
  return keys
    .map((k) => decodeProjectFileSelectValue(k)?.id)
    .filter((id): id is string => Boolean(id));
}

const CO_CREATE_FAST_QUERY_MAX_CHARS = 20;
const CO_CREATE_REWRITE_RE =
  /\/(生成新文件|改写当前文件)|修改|改写|重写|润色|增加|补充|加入|添加|创建|新建|保存|写入|覆盖|patch|diff|apply/i;
const CO_CREATE_FILE_TARGET_RE = /文件|文档|附件|输出物|版本|副本/i;
const CO_CREATE_PROJECT_HEAVY_RE = /当前项目|本项目|这个项目|项目内|项目中|基于项目/i;
const CO_CREATE_RESEARCH_RE =
  /研究|分析|深度|拆解|挖掘|对标|矩阵|趋势|策略|行业|市场|用户|竞品|报告/i;

export function shouldUseCoCreateFastPath(options: {
  text: string;
  pinnedFileCount: number;
  roundFileCount: number;
  regionBlockCount: number;
}) {
  const compact = options.text.replace(/\s+/g, "");
  if (!compact) return false;
  if (isDocumentGenerationPrompt(options.text.trim())) return false;
  if (options.pinnedFileCount > 0 || options.roundFileCount > 0 || options.regionBlockCount > 0) {
    return false;
  }
  if (compact.length > CO_CREATE_FAST_QUERY_MAX_CHARS) return false;
  if (CO_CREATE_REWRITE_RE.test(compact) || CO_CREATE_FILE_TARGET_RE.test(compact)) return false;
  if (CO_CREATE_PROJECT_HEAVY_RE.test(compact)) return false;
  return true;
}

export function resolveCoCreatePipeline(options: {
  text: string;
  pinnedFileCount: number;
  roundFileCount: number;
  regionBlockCount: number;
  hasPendingFileActions?: boolean;
}): CoCreatePipeline {
  const compact = options.text.replace(/\s+/g, "");
  if (options.hasPendingFileActions) return "rewrite";
  if (CO_CREATE_REWRITE_RE.test(compact)) return "rewrite";
  if (
    (options.roundFileCount > 0 || options.pinnedFileCount > 0) &&
    isRewritePrompt(options.text.trim(), { hasTargetFile: true })
  ) {
    return "rewrite";
  }
  if (isDocumentGenerationPrompt(options.text.trim())) return "co_create";
  if (shouldUseCoCreateFastPath(options)) return "fast";
  if (
    CO_CREATE_RESEARCH_RE.test(compact) ||
    CO_CREATE_PROJECT_HEAVY_RE.test(compact) ||
    compact.length > 40
  ) {
    return "research";
  }
  return "co_create";
}

export function regionBlockFileName(
  files: ProjectFileItem[],
  fileKey: string,
  tabLabels: Record<string, string>,
): string {
  const decoded = decodeProjectFileSelectValue(fileKey);
  if (!decoded) return tabLabels[fileKey] ?? "文件";
  const file = files.find((f) => f.id === decoded.id && f.kind === decoded.kind);
  const pathName = file?.path?.split("/").filter(Boolean).pop();
  return pathName || file?.title || tabLabels[fileKey] || "文件";
}

export function parsePatchEditMode(raw: unknown): PatchEditMode {
  const value = String(raw ?? "full");
  if (value === "search_replace" || value === "line_range" || value === "full") return value;
  return "full";
}

export function parseOptionalInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function mapStreamActions(raw: Array<Record<string, unknown>>): FileActionProposal[] {
  const out: FileActionProposal[] = [];
  for (const item of raw) {
    const proposalId = String(item.proposal_id || item.proposalId || randomUUID());
    const type = String(item.type || "");
    if (type === "create") {
      const fileName = String(item.file_name || item.fileName || "新文件.md");
      out.push({
        type: "create",
        proposalId,
        fileName,
        path: normalizeCreateFilePath(fileName, String(item.path || "/")),
        content: String(item.content || ""),
        status: "proposed",
      });
    } else if (type === "patch") {
      const editMode = parsePatchEditMode(item.edit_mode ?? item.editMode);
      const oldString = String(item.old_string ?? item.oldString ?? "");
      const newString = String(item.new_string ?? item.newString ?? "");
      const newText = String(item.new_text ?? item.newText ?? "");
      const startLine = parseOptionalInt(item.start_line ?? item.startLine);
      const endLine = parseOptionalInt(item.end_line ?? item.endLine);
      let after = String(item.after || item.content || "");
      if (!after && editMode === "search_replace") after = newString;
      if (!after && editMode === "line_range") after = newText;
      out.push({
        type: "patch",
        proposalId,
        fileId: String(item.file_id || item.fileId || ""),
        fileKind: (item.file_kind || item.fileKind || "output") as "output" | "attachment",
        fileName: String(item.file_name || item.fileName || "文件"),
        summary: String(item.summary || "文件修改"),
        before: String(item.before || ""),
        after,
        status: "proposed",
        editMode,
        oldString: oldString || undefined,
        newString: newString || undefined,
        replaceAll: Boolean(item.replace_all ?? item.replaceAll),
        startLine,
        endLine,
        newText: newText || undefined,
      });
    }
  }
  return out;
}

export function resolveAutoPatchTargetFile(
  pinnedFileKeys: string[],
  roundFileKeys: string[],
  files: ProjectFileItem[],
  tabLabels: Record<string, string>,
): AutoPatchTargetFile | null {
  for (const fileKey of [...roundFileKeys, ...pinnedFileKeys]) {
    const decoded = decodeProjectFileSelectValue(fileKey);
    if (!decoded || !isCoCreateWritableFileKind(decoded.kind)) continue;
    return {
      fileKey,
      fileId: decoded.id,
      fileKind: decoded.kind,
      fileName: regionBlockFileName(files, fileKey, tabLabels),
    };
  }
  return null;
}

export async function resolveFileBeforeContent(
  projectId: string,
  target: AutoPatchTargetFile,
  activeFileKey: string | null,
  previewContent: string | undefined,
): Promise<string> {
  if (activeFileKey === target.fileKey && previewContent?.trim()) {
    return previewContent;
  }
  const detail = await fetchProjectFileDetail(projectId, target.fileId, target.fileKind);
  return detail.content ?? "";
}

export function updateProposalStatus(
  proposalId: string,
  status: FileActionProposal["status"],
  actions: FileActionProposal[],
  patch?: { applyError?: string },
): FileActionProposal[] {
  return actions.map((proposal) => {
    if (proposal.proposalId !== proposalId) return proposal;
    return { ...proposal, status, ...patch };
  });
}

export function findAssistantContentForProposal(
  session: { messages: Message[] } | undefined,
  proposalId: string,
): string {
  if (!session) return "";
  const hostMessage = session.messages.find((message) =>
    message.fileActions?.some((fa) => fa.proposalId === proposalId),
  );
  return hostMessage?.content ?? "";
}

