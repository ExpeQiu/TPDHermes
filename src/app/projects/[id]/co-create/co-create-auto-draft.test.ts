import { describe, expect, it } from "vitest";

import {
  buildDocumentSyncInstructions,
  extractAutoCreateDraftBody,
  inferAutoCreateDraftFileName,
  inferQuickCreateOutputFileName,
  isDocumentGenerationPrompt,
  isReadyForAutoCreateDraft,
  normalizeAutoCreateDraftContent,
  shouldAutoCreateDraftFromAssistant,
  shouldQuickStartAutoCreateDraft,
  buildQuickStartOutputSyncInstructions,
} from "@/app/projects/[id]/co-create/co-create-auto-draft";

describe("co-create-auto-draft", () => {
  it("normalizes assistant markdown before auto creating a draft", () => {
    const content = `
\`\`\`markdown
# 产品需求文档

这里是正文。
\`\`\`

\`\`\`tphermes_file_actions
{"actions":[{"type":"create","fileName":"忽略.md"}]}
\`\`\`
`;

    expect(normalizeAutoCreateDraftContent(content)).toBe("# 产品需求文档\n\n这里是正文。");
  });

  it("rejects preamble-only assistant output", () => {
    const preamble = `先检索吉利最新的超充技术信息，确保内容有据可依。
信息检索完毕。核心素材包括：
威睿能源600kW超充（2022）
浩瀚能源主导发布首个800V超充站标准（2025-09）
现在撰写完整发布会稿。
发布会稿已完成，`;

    expect(isReadyForAutoCreateDraft(extractAutoCreateDraftBody(preamble), preamble)).toBe(false);
    expect(
      shouldAutoCreateDraftFromAssistant("撰写一篇吉利超充技术发布会稿", preamble),
    ).toBe(false);
  });

  it("accepts full draft with title and body", () => {
    const body = "吉利超充技术发布会稿\n" + "正文段落。\n".repeat(80);
    expect(
      shouldAutoCreateDraftFromAssistant("撰写一篇吉利超充技术发布会稿", `前言\n${body}`),
    ).toBe(true);
  });

  it("extracts draft body without retrieval preamble", () => {
    const news = `先搜集吉利超充技术的最新信息。
基于搜索到的吉利最新超充技术信息，撰写如下：
吉利科技集团闪充技术发布会新闻稿
杭州，2026年4月7日 —— 正文开始。` + "x".repeat(400);

    expect(extractAutoCreateDraftBody(news)).toMatch(/^吉利科技集团闪充技术发布会新闻稿/);
    expect(extractAutoCreateDraftBody(news)).not.toMatch(/^先搜集/);
  });

  it("infers file name from plain title or prompt", () => {
    expect(
      inferAutoCreateDraftFileName(
        "撰写一篇吉利超充技术发布会稿",
        "吉利科技集团闪充技术发布会新闻稿\n正文",
      ),
    ).toBe("吉利科技集团闪充技术发布会新闻稿.md");
  });

  it("builds document sync instructions for generation prompts", () => {
    expect(isDocumentGenerationPrompt("撰写一篇吉利超充技术发布会稿")).toBe(true);
    expect(
      isDocumentGenerationPrompt("请基于当前项目上下文，输出一版可用于外部沟通的技术方案说明。"),
    ).toBe(true);
    const text = buildDocumentSyncInstructions("撰写一篇演讲稿");
    expect(text).toContain("tphermes_file_actions");
    expect(buildDocumentSyncInstructions("今天天气怎么样")).toBe("");
  });

  it("unwraps skill JSON envelope before extracting draft body", () => {
    const raw = JSON.stringify({
      skill: "tech_trend_skill",
      content: "# 技术方向趋势研判\n\n" + "正文段落。\n".repeat(40),
    });
    const body = extractAutoCreateDraftBody(raw);
    expect(body).toMatch(/^# 技术方向趋势研判/);
    expect(shouldQuickStartAutoCreateDraft("技术方案说明", "输出技术方案", raw)).toBe(true);
  });

  it("prefers quick entry title for output file name", () => {
    expect(
      inferQuickCreateOutputFileName(
        "技术方案说明",
        "请输出技术方案说明",
        "# 技术方向趋势研判\n正文",
      ),
    ).toBe("技术方案说明.md");
  });

  it("builds quick start output sync instructions with standard path", () => {
    const text = buildQuickStartOutputSyncInstructions(
      "技术方案说明",
      "请基于当前项目上下文，输出一版技术方案说明。",
    );
    expect(text).toContain("【快捷创作标准输出】");
    expect(text).toContain("/输出/技术方案说明.md");
  });
});
