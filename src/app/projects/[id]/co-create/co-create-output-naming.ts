import type { ProjectFileItem } from "@/lib/co-create-api";

/** 输出物 title 比较键：忽略大小写与 .md / .markdown 后缀 */
export function normalizeOutputFileStem(title: string): string {
  let t = (title || "").trim().toLowerCase();
  if (t.endsWith(".markdown")) t = t.slice(0, -9);
  else if (t.endsWith(".md")) t = t.slice(0, -3);
  return t.trim();
}

export function normalizeOutputFileName(title: string): string {
  const cleaned = (title || "").trim() || "自动创建文稿";
  return /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
}

export function collectOutputTitles(files: readonly ProjectFileItem[]): string[] {
  return files.filter((f) => f.kind === "output").map((f) => f.title);
}

export function isOutputTitleTaken(
  candidate: string,
  existingTitles: readonly string[],
): boolean {
  const stem = normalizeOutputFileStem(normalizeOutputFileName(candidate));
  return existingTitles.some((title) => normalizeOutputFileStem(title) === stem);
}

/** 在已有输出物标题冲突时追加 -2、-3… 后缀，避免项目文件列表重名 */
export function resolveUniqueOutputFileName(
  baseName: string,
  existingTitles: readonly string[],
): string {
  const normalized = normalizeOutputFileName(baseName);
  if (!isOutputTitleTaken(normalized, existingTitles)) return normalized;

  const stem = normalizeOutputFileStem(normalized);
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${stem}-${i}.md`;
    if (!isOutputTitleTaken(candidate, existingTitles)) return candidate;
  }
  return `${stem}-${Date.now()}.md`;
}

export function buildExistingOutputNamesHint(existingTitles: readonly string[]): string {
  const outputs = existingTitles.map((t) => t.trim()).filter(Boolean);
  if (outputs.length === 0) return "";
  const preview = outputs.slice(0, 12).join("、");
  const suffix = outputs.length > 12 ? ` 等 ${outputs.length} 个` : "";
  return [
    "【输出物命名】项目已有输出文件：",
    preview + suffix,
    "。新建文件须使用与上述不重复的文件名（勿仅改 .md 后缀）；",
    "若需更新已有文件请 patch 该文件，勿 create 同名。",
  ].join("");
}
