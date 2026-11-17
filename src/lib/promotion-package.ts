/** 复杂文稿改由共创等路径完成，技术推广包只保留可一次成稿的出品。 */
export const RETIRED_PROMOTION_PRODUCTS = [
  "speech_skill",
  "speech_draft_skill",
  "video_skill",
  "video_script_skill",
  "material_skill",
] as const;

export const PROMOTION_PRODUCTS = [
  { id: "a4_skill", label: "A4 技术一页纸" },
  { id: "tech_pr_skill", label: "技术通稿" },
  { id: "interview_qa_skill", label: "采访 QA" },
  { id: "sales_skill", label: "销售话术" },
  { id: "geo_card_skill", label: "GEO结构化信息卡" },
] as const;

export const DEFAULT_PROMOTION_PRODUCTS = ["a4_skill", "tech_pr_skill", "interview_qa_skill"];

export function promotionProductLabel(id: string): string {
  return PROMOTION_PRODUCTS.find((item) => item.id === id)?.label ?? id;
}

export interface PromotionField {
  key: string;
  status: string;
  blocks?: string[];
}

export interface PromotionVersion {
  product: string;
  status: string;
  factIds: string[];
}

export interface ExportChoice {
  id: string;
  status: string;
  stale: boolean;
}

export function blockedProductIds(fields: PromotionField[]): string[] {
  const names = new Set<string>();
  for (const field of fields) {
    if (field.status !== "missing" && field.status !== "conflict") continue;
    for (const product of field.blocks ?? []) names.add(product);
  }
  return [...names].sort();
}

export function approvalsAfterFactChange(
  versions: PromotionVersion[],
  changedFactIds: string[],
): PromotionVersion[] {
  const changed = new Set(changedFactIds);
  return versions.map((version) => {
    const cited = version.factIds.some((factId) => changed.has(factId));
    if (version.status === "approved" && cited) {
      return { ...version, status: "needs_rereview" };
    }
    return version;
  });
}

export interface StructuredAccuracyRow {
  metric: string;
  value: string;
  condition: string;
  source: string;
}

function cleanCell(value: string): string {
  return value.replace(/\*\*/g, "").replace(/<br\s*\/?>/gi, " ").trim();
}

/** 从资料中的指标表抽出带数值和口径的条目，占位符不算高准确信息。 */
export function structuredHighAccuracyRows(content: string, source = ""): StructuredAccuracyRow[] {
  const rows: StructuredAccuracyRow[] = [];
  let headers: string[] = [];
  for (const raw of (content || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|") || !line.endsWith("|")) {
      headers = [];
      continue;
    }
    const cells = line.split("|").slice(1, -1).map(cleanCell);
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!headers.length) {
      headers = cells;
      continue;
    }
    const metric = cells[0] || "";
    const value = cells[1] || "";
    const condition = cells.slice(2).filter(Boolean).join("；");
    if (!metric || !value || value.includes("待补充")) continue;
    rows.push({ metric, value, condition, source });
  }
  return rows;
}

export function exportConflicts(choices: ExportChoice[]): { id: string; reason: string }[] {
  return choices.flatMap((choice) => {
    if (choice.stale) return [{ id: choice.id, reason: "facts_changed" }];
    if (choice.status !== "approved") return [{ id: choice.id, reason: "not_approved" }];
    return [];
  });
}
