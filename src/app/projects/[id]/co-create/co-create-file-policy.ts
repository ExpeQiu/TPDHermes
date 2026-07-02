"use client";

import { decodeProjectFileSelectValue, type ProjectFileKind } from "@/lib/chat-context";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

/** 共创写回规则：附件只读，仅可创建/修改输出物 */
export const CO_CREATE_OUTPUT_WRITE_POLICY = [
  "【文件写回规则】项目 /附件/ 为上传只读材料，禁止 patch 或覆盖修改 attachment。",
  "仅可 create 新输出物，或 patch 已有输出物（/输出/）。",
  "基于附件改写时：读取附件后 create 写入 /输出/ 新文件，或 patch 已有输出物，勿改原附件。",
].join(" ");

export const CO_CREATE_ATTACHMENT_READONLY_ERROR =
  "上传附件不可直接修改，请基于附件内容创建或修改输出物（/输出/）";

export function isCoCreateWritableFileKind(kind: ProjectFileKind): boolean {
  return kind === "output";
}

export function isCoCreateAttachmentFileKey(fileKey: string): boolean {
  const decoded = decodeProjectFileSelectValue(fileKey);
  return decoded?.kind === "attachment";
}

export function isCoCreateAttachmentPatchProposal(
  proposal: Pick<FileActionProposal, "type"> & { fileKind?: ProjectFileKind },
): boolean {
  return proposal.type === "patch" && proposal.fileKind === "attachment";
}

export function rejectCoCreateAttachmentPatchProposals(
  proposals: FileActionProposal[],
): FileActionProposal[] {
  return proposals.map((proposal) => {
    if (!isCoCreateAttachmentPatchProposal(proposal)) return proposal;
    if (proposal.status === "applied" || proposal.status === "rejected") return proposal;
    return {
      ...proposal,
      status: "rejected" as const,
      applyError: CO_CREATE_ATTACHMENT_READONLY_ERROR,
    };
  });
}
