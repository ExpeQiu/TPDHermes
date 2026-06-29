/**
 * 技能直连/工坊输出：从 {"skill","content",...} JSON 信封中提取用户可见 Markdown。
 */
export function unwrapSkillAssistantMarkdown(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return raw;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const content = parsed.content;
    if (typeof content === "string" && content.trim()) {
      const body = content.trim();
      const title = parsed.title;
      if (typeof title === "string" && title.trim() && !body.startsWith("#")) {
        return `# ${title.trim()}\n\n${body}`;
      }
      return body;
    }
  } catch {
    /* 流式未收齐或非标 JSON，保留原文 */
  }

  return raw;
}
