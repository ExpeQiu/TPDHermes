/** 解析 /new 指令，返回可选会话标题；非 /new 指令返回 null */
export function parseCoCreateNewCommand(input: string): { title?: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/new(?:\s+(.*))?$/i);
  if (!match) return null;
  const title = match[1]?.trim();
  return title ? { title } : {};
}
