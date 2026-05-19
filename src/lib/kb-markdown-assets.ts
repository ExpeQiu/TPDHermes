import { apiV1 } from "@/lib/api";

/** 知识库 Markdown 渲染时的 Obsidian 资源解析上下文 */
export type KbMarkdownAssetContext = {
  folderPath?: string;
  sourceVaultFile?: string;
};

/**
 * 将 Obsidian 相对图片路径转为后端 Vault 代理 URL。
 * 外链、data URL 原样返回。
 */
export function resolveKbMarkdownAssetUrl(
  src: string | undefined,
  ctx?: KbMarkdownAssetContext,
): string | undefined {
  if (!src) return undefined;
  const trimmed = src.trim();
  if (
    /^https?:\/\//i.test(trimmed) ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:")
  ) {
    return trimmed;
  }
  if (trimmed.startsWith("/api/")) {
    return trimmed;
  }

  const params = new URLSearchParams({ path: trimmed });
  const noteFolder = ctx?.sourceVaultFile
    ? ctx.sourceVaultFile.replace(/\\/g, "/").replace(/\/[^/]+$/, "")
    : ctx?.folderPath?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (noteFolder) {
    params.set("note_folder", noteFolder);
  }
  if (ctx?.sourceVaultFile) {
    params.set("source_vault_file", ctx.sourceVaultFile.replace(/\\/g, "/"));
  }
  return apiV1(`/kb/vault-asset?${params.toString()}`);
}
