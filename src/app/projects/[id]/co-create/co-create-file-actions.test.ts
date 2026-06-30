import { describe, expect, it } from "vitest";

import { extractAutoCreateDraftBody } from "@/app/projects/[id]/co-create/co-create-auto-draft";
import { extractAutoPatchBody } from "@/app/projects/[id]/co-create/co-create-auto-patch";
import {
  dedupeCreateProposals,
  isCreateProposalReadyForApply,
  normalizeCreateFilePath,
  normalizeStreamCreateProposal,
  normalizeStreamPatchProposal,
  prunePendingCreatesForAssistantMessage,
  reconcileStreamCreateProposals,
  reconcileStreamPatchProposals,
  resolveCreateActionContent,
  stripFileActionsBlock,
} from "@/app/projects/[id]/co-create/co-create-file-actions";

describe("co-create-file-actions", () => {
  it("stripFileActionsBlock 移除 tphermes 与裸露 actions JSON", () => {
    const raw = `正文开头

\`\`\`tphermes_file_actions
{"actions":[{"type":"create"}]}
\`\`\`

结尾`;

    expect(stripFileActionsBlock(raw)).toBe("正文开头\n\n结尾");

    const loose = `前文\n\`\`\`json\n{"actions":[{"type":"create"}]}\n\`\`\``;
    expect(stripFileActionsBlock(loose)).toBe("前文");
  });

  it("normalizeCreateFilePath 将本机路径转为 /输出/", () => {
    expect(
      normalizeCreateFilePath("吉利超充技术发布会演讲稿.md", "/Users/expeqiu/吉利超充技术发布会演讲稿.md"),
    ).toBe("/输出/吉利超充技术发布会演讲稿.md");
    expect(normalizeCreateFilePath("a.md", "/输出/a.md")).toBe("/输出/a.md");
  });

  it("resolveCreateActionContent 从正文补全空 content", () => {
    const body = "吉利超充技术发布会演讲稿\n" + "段落。\n".repeat(30);
    const assistant = `说明\n${body}\n\`\`\`tphermes_file_actions\n{}\n\`\`\``;
    expect(resolveCreateActionContent("", assistant, extractAutoCreateDraftBody)).toContain(
      "吉利超充技术发布会演讲稿",
    );
  });

  it("normalizeStreamCreateProposal 规范化 stream create", () => {
    const normalized = normalizeStreamCreateProposal(
      {
        type: "create",
        proposalId: "p1",
        fileName: "稿.md",
        path: "/Users/x/稿.md",
        content: "",
        status: "proposed",
      },
      "吉利超充技术发布会演讲稿\n" + "x".repeat(200),
      extractAutoCreateDraftBody,
    );
    expect(normalized.path).toBe("/输出/稿.md");
    expect(normalized.content.length).toBeGreaterThan(80);
  });

  it("reconcileStreamCreateProposals 在正文就绪后将 failed 重置为 proposed", () => {
    const assistant = "吉利超充技术发布会演讲稿\n" + "正文段落。\n".repeat(40);
    const reconciled = reconcileStreamCreateProposals(
      [
        {
          type: "create",
          proposalId: "p1",
          fileName: "稿.md",
          path: "/输出/稿.md",
          content: "",
          status: "failed",
          applyError: "创建文件内容不能为空",
        },
      ],
      assistant,
      extractAutoCreateDraftBody,
    );
    expect(reconciled[0]?.status).toBe("proposed");
    expect(reconciled[0]?.type === "create" && reconciled[0].content.length).toBeGreaterThan(80);
    expect(reconciled[0]?.type === "create" && reconciled[0].applyError).toBeUndefined();
  });

  it("isCreateProposalReadyForApply 正文不足时返回 false", () => {
    expect(isCreateProposalReadyForApply("", "短", extractAutoCreateDraftBody)).toBe(false);
    expect(
      isCreateProposalReadyForApply(
        "",
        "吉利超充技术发布会演讲稿\n" + "x".repeat(120),
        extractAutoCreateDraftBody,
      ),
    ).toBe(true);
  });

  it("normalizeStreamPatchProposal 从助手正文补全 after", () => {
    const before = "原标题\n" + "段落。\n".repeat(30);
    const after = before + "\n\n扩展段落。\n" + "x".repeat(200);
    const assistant = `好的，已润色。\n\n${after}`;
    const normalized = normalizeStreamPatchProposal(
      {
        type: "patch",
        proposalId: "p1",
        fileId: "file-1",
        fileKind: "output",
        fileName: "稿.md",
        before: "",
        after: "",
        editMode: "full",
        summary: "润色",
        status: "proposed",
      },
      assistant,
      before,
      extractAutoPatchBody,
    );
    expect(normalized.before?.trim()).toBe(before.trim());
    expect(normalized.after.length).toBeGreaterThan(80);
    expect(normalized.after).toContain("扩展段落");
  });

  it("reconcileStreamPatchProposals 正文就绪后将 failed 重置为 proposed", () => {
    const before = "原标题\n" + "段落。\n".repeat(30);
    const after = before + "\n\n扩展段落。\n" + "x".repeat(200);
    const assistant = `好的，已润色。\n\n${after}`;
    const reconciled = reconcileStreamPatchProposals(
      [
        {
          type: "patch",
          proposalId: "p1",
          fileId: "file-1",
          fileKind: "output",
          fileName: "稿.md",
          before,
          after: "",
          editMode: "full",
          summary: "润色",
          status: "failed",
          applyError: "改写内容不能为空",
        },
      ],
      assistant,
      before,
      extractAutoPatchBody,
    );
    expect(reconciled[0]?.status).toBe("proposed");
    expect(reconciled[0]?.type === "patch" && reconciled[0].after.length).toBeGreaterThan(80);
    expect(reconciled[0]?.type === "patch" && reconciled[0].applyError).toBeUndefined();
  });

  it("dedupeCreateProposals 同路径仅保留 stream 提案", () => {
    const deduped = dedupeCreateProposals([
      {
        type: "create",
        proposalId: "fallback-create:assistant-1",
        fileName: "营销推广文案.md",
        path: "/输出/营销推广文案.md",
        content: "fallback",
        status: "proposed",
      },
      {
        type: "create",
        proposalId: "stream-1",
        fileName: "营销推广文案.md",
        path: "/输出/营销推广文案.md",
        content: "stream",
        status: "proposed",
      },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.proposalId).toBe("stream-1");
  });

  it("prunePendingCreatesForAssistantMessage 清理同轮 fallback 与重复 create", () => {
    const pruned = prunePendingCreatesForAssistantMessage(
      [
        {
          type: "create",
          proposalId: "fallback-create:assistant-1",
          fileName: "营销推广文案.md",
          path: "/输出/营销推广文案.md",
          content: "fallback",
          status: "proposed",
        },
        {
          type: "patch",
          proposalId: "patch-1",
          fileId: "f1",
          fileKind: "output",
          fileName: "稿.md",
          before: "a",
          after: "b",
          status: "proposed",
        },
      ],
      "assistant-1",
      [
        {
          type: "create",
          proposalId: "stream-1",
          fileName: "营销推广文案.md",
          path: "/输出/营销推广文案.md",
          content: "stream",
          status: "proposed",
        },
      ],
    );
    expect(pruned.some((item) => item.proposalId === "fallback-create:assistant-1")).toBe(false);
    expect(pruned.some((item) => item.proposalId === "patch-1")).toBe(true);
  });
});
