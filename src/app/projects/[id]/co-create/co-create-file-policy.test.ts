import { describe, expect, it } from "vitest";

import {
  CO_CREATE_ATTACHMENT_READONLY_ERROR,
  CO_CREATE_OUTPUT_WRITE_POLICY,
  isCoCreateAttachmentFileKey,
  isCoCreateAttachmentPatchProposal,
  rejectCoCreateAttachmentPatchProposals,
} from "@/app/projects/[id]/co-create/co-create-file-policy";

describe("co-create-file-policy", () => {
  it("CO_CREATE_OUTPUT_WRITE_POLICY 声明默认落库 outputs 并在「输出物」展示", () => {
    expect(CO_CREATE_OUTPUT_WRITE_POLICY).toContain("outputs 表");
    expect(CO_CREATE_OUTPUT_WRITE_POLICY).toContain("content 字段");
    expect(CO_CREATE_OUTPUT_WRITE_POLICY).toContain("输出物");
    expect(CO_CREATE_OUTPUT_WRITE_POLICY).toContain("/输出/");
  });

  it("isCoCreateAttachmentFileKey 识别 attachment 引用", () => {
    expect(isCoCreateAttachmentFileKey("attachment:att-1")).toBe(true);
    expect(isCoCreateAttachmentFileKey("output:out-1")).toBe(false);
  });

  it("rejectCoCreateAttachmentPatchProposals 拒绝 attachment patch", () => {
    const next = rejectCoCreateAttachmentPatchProposals([
      {
        type: "patch",
        proposalId: "p1",
        fileId: "att-1",
        fileKind: "attachment",
        fileName: "brief.docx",
        summary: "",
        after: "x",
        status: "proposed",
      },
      {
        type: "patch",
        proposalId: "p2",
        fileId: "out-1",
        fileKind: "output",
        fileName: "稿.md",
        summary: "",
        after: "y",
        status: "proposed",
      },
    ]);
    expect(isCoCreateAttachmentPatchProposal(next[0]!)).toBe(true);
    expect(next[0]?.status).toBe("rejected");
    expect(next[0]?.applyError).toBe(CO_CREATE_ATTACHMENT_READONLY_ERROR);
    expect(next[1]?.status).toBe("proposed");
  });
});
