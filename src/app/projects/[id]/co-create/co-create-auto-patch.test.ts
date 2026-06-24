import { describe, expect, it } from "vitest";

import {
  buildRewriteSyncInstructions,
  extractAutoPatchBody,
  isReadyForAutoPatch,
  isRewritePrompt,
  shouldAutoPatchFromAssistant,
} from "@/app/projects/[id]/co-create/co-create-auto-patch";

describe("co-create-auto-patch", () => {
  it("isRewritePrompt 识别润色改写", () => {
    expect(isRewritePrompt("文稿内容准确，稍作润色并扩展至800字以上")).toBe(true);
    expect(isRewritePrompt("/改写当前文件 压缩第二段")).toBe(true);
    expect(isRewritePrompt("撰写一篇吉利超充技术发布会演讲稿")).toBe(false);
    expect(
      isRewritePrompt("增加一些用户视角的洞察", { hasTargetFile: true }),
    ).toBe(true);
    expect(isRewritePrompt("增加一些用户视角的洞察", { hasTargetFile: false })).toBe(
      false,
    );
    expect(isRewritePrompt("解释一下这篇稿子的结构", { hasTargetFile: true })).toBe(
      false,
    );
  });

  it("buildRewriteSyncInstructions 有引用文件时注入", () => {
    const text = buildRewriteSyncInstructions("润色并扩展文稿", true);
    expect(text).toContain("tphermes_file_actions");
    expect(text).toContain("patch");
    expect(buildRewriteSyncInstructions("润色", false)).toBe("");
  });

  it("isReadyForAutoPatch 要求正文有实质变化", () => {
    const before = "短稿。\n".repeat(20);
    const after = before + "\n\n扩展段落。\n".repeat(30);
    expect(isReadyForAutoPatch(after, before, after)).toBe(true);
    expect(isReadyForAutoPatch(before, before, before)).toBe(false);
  });

  it("shouldAutoPatchFromAssistant 润色场景", () => {
    const before = "原标题\n" + "段落。\n".repeat(30);
    const assistant = `好的，已润色。\n\n${before}\n\n新增扩展内容。\n${"x".repeat(200)}`;
    const after = extractAutoPatchBody(assistant);
    expect(
      shouldAutoPatchFromAssistant("润色并扩展至800字", assistant, before, false),
    ).toBe(isReadyForAutoPatch(after, before, assistant));
  });

  it("润色场景端到端：无 stream actions 时可触发 fallback-patch 条件", () => {
    const before = "i-HEV智擎混动发布会稿\n" + "正文段落。\n".repeat(40);
    const polished = `${before}\n\n## 扩展\n${"润色扩展内容。\n".repeat(50)}`;
    const assistantReply = `已按您的要求润色并扩展至 800 字以上：\n\n${polished}`;
    expect(isRewritePrompt("文稿内容准确，稍作润色并扩展至800字以上")).toBe(true);
    expect(
      shouldAutoPatchFromAssistant(
        "文稿内容准确，稍作润色并扩展至800字以上",
        assistantReply,
        before,
        false,
      ),
    ).toBe(true);
    expect(
      shouldAutoPatchFromAssistant(
        "文稿内容准确，稍作润色并扩展至800字以上",
        assistantReply,
        before,
        true,
      ),
    ).toBe(false);
  });

  it("用户洞察增补场景端到端", () => {
    const before = "吉利超充技术发布会演讲稿\n" + "尊敬的各位嘉宾。\n" + "段落。\n".repeat(35);
    const after =
      "吉利超充技术发布会演讲稿（含竞品对标+用户洞察）\n" +
      before.split("\n").slice(1).join("\n") +
      "\n\n## 用户洞察\n" +
      "用户最关心的仍是充电焦虑。\n".repeat(20);
    const assistantReply = `我先检索一下主流竞品的超充技术数据。\n现在整理对标数据，开始改写演讲稿。\n\n${after}`;
    expect(
      shouldAutoPatchFromAssistant(
        "增加一些用户视角的洞察",
        assistantReply,
        before,
        false,
        true,
      ),
    ).toBe(true);
  });
});
