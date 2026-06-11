/** 知识库 collection 业务展示名（覆盖默认 domain·topic 拼接） */
export const KB_COLLECTION_DISPLAY: Record<string, string> = {
  "public.structured_tech.geely_tech": "公开情报·技术库",
  "internal.structured_tech.tech_points": "内部知识库·技术点",
  "public.release_assets.speeches": "发布素材·发言稿",
};

/** collection 业务说明（UI tooltip / 编排提示） */
export const KB_COLLECTION_DESCRIPTIONS: Record<string, string> = {
  "public.structured_tech.geely_tech":
    "来自互联网检索的结构化技术点信息，供参考与补充，冲突时以真源集合为准。",
  "internal.structured_tech.tech_points":
    "内部官方技术点汇编（JLGF），真源信息，优先遵守和采纳。",
  "public.release_assets.speeches":
    "发言稿与发布口径，真源信息，优先遵守和采纳。",
};

/** 真源集合：Agent 与写作场景冲突时优先采纳 */
export const KB_AUTHORITATIVE_COLLECTIONS: readonly string[] = [
  "internal.structured_tech.tech_points",
  "public.release_assets.speeches",
];

/** 「内部知识库」区块展示顺序（发言稿虽为 public.*，与真源技术点同区展示） */
export const KB_INTERNAL_SECTION_ORDER: readonly string[] = [
  "internal.structured_tech.tech_points",
  "public.release_assets.speeches",
];

/** 浏览 UI 隐藏的集合（联调 / smoke 等） */
export const KB_HIDDEN_COLLECTIONS: ReadonlySet<string> = new Set([
  "internal.structured_tech.smoke",
  "public.structured_tech.remote_debug",
]);

export function isAuthoritativeKbCollection(name: string): boolean {
  return KB_AUTHORITATIVE_COLLECTIONS.includes(name.trim());
}

export function kbCollectionDescription(name: string): string | undefined {
  const key = name.trim();
  return KB_COLLECTION_DESCRIPTIONS[key];
}

/** 内部知识库 collection（scope=internal，在按集合浏览中独立展示为按钮） */
export function isInternalKbCollection(name: string): boolean {
  return name.trim().startsWith("internal.");
}

export function isKbCollectionHidden(name: string): boolean {
  return KB_HIDDEN_COLLECTIONS.has(name.trim());
}

/** 是否在「内部知识库」按钮区展示（含真源发言稿） */
export function isInternalSectionCollection(name: string): boolean {
  const key = name.trim();
  if (isKbCollectionHidden(key)) return false;
  return KB_INTERNAL_SECTION_ORDER.includes(key);
}

export function sortInternalSectionCollections<T extends { name: string }>(
  cols: T[],
): T[] {
  const order = new Map(KB_INTERNAL_SECTION_ORDER.map((n, i) => [n, i]));
  return [...cols].sort(
    (a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99),
  );
}
