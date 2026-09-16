/** 知识库 collection 业务展示名（覆盖默认 domain·topic 拼接） */
export const KB_COLLECTION_DISPLAY: Record<string, string> = {
  "internal.geelywiki.pages": "内部知识库·GeelyWiki",
  "public.structured_tech.geely_tech": "公开情报·技术库",
  "public.public_intel.auto_company_strategy": "公开情报·车企战略",
  "public.public_intel.vehicle_model_library": "公开情报·车型库",
  "public.internal_methodology.tpd_experience": "公共知识库·经验库",
  "internal.structured_tech.tech_points": "内部知识库·技术点（历史）",
  "public.release_assets.speeches": "发布素材·发言稿（历史）",
};

/** collection 业务说明（UI tooltip / 编排提示） */
export const KB_COLLECTION_DESCRIPTIONS: Record<string, string> = {
  "internal.geelywiki.pages":
    "GeelyWiki 内部 LLMwiki 归档（全文 + claims），真源信息，冲突时优先遵守和采纳。",
  "public.structured_tech.geely_tech":
    "来自互联网检索的结构化技术点信息，供参考与补充，冲突时以真源集合为准。",
  "public.public_intel.auto_company_strategy":
    "公开情报·车企战略，向量+图谱补充，不得覆盖内部 Wiki 搭载。",
  "public.public_intel.vehicle_model_library":
    "公开情报·车型库（竞品/行业），向量+图谱补充。",
  "public.internal_methodology.tpd_experience":
    "对话与反馈沉淀的经验库，可检索可图谱化，权威低于内部 Wiki。",
  "internal.structured_tech.tech_points":
    "历史 myKW 直推技术点（已停用直推；现行真源为 GeelyWiki）。",
  "public.release_assets.speeches":
    "历史发言稿集合（现行发布口径编入 GeelyWiki 后随内部 Wiki 检索）。",
};

/** 真源集合：Agent 与写作场景冲突时优先采纳 */
export const KB_AUTHORITATIVE_COLLECTIONS: readonly string[] = [
  "internal.geelywiki.pages",
];

/** 「内部知识库」区块展示顺序 */
export const KB_INTERNAL_SECTION_ORDER: readonly string[] = [
  "internal.geelywiki.pages",
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

/** 是否在「内部知识库」按钮区展示 */
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

/** 场景编排可选绑定的 collection：public/internal 真源，排除 project.* 与联调测试集合 */
export function isBindableKbCollection(name: string): boolean {
  const key = name.trim();
  if (!key) return false;
  if (isKbCollectionHidden(key)) return false;
  if (/^project\.[^.]+\.kb$/.test(key)) return false;
  if (/\.test\.|\.smoke\b|remote_debug/.test(key)) return false;
  const parts = key.split(".").filter(Boolean);
  if (parts.length < 3) return false;
  const scope = parts[0];
  return scope === "public" || scope === "internal";
}

export function filterBindableKbCollections(collections: string[]): string[] {
  return collections.filter(isBindableKbCollection);
}
