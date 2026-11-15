import type { WorkshopSkillCatalogItem } from "@/lib/chat-context";
import { skillLabel } from "@/lib/ui-labels";

export type ChatSkillOption = {
  name: string;
  label: string;
  hint: string;
  keywords: string;
};

export function chatSkillOptions(
  names: string[],
  catalog: WorkshopSkillCatalogItem[] = [],
): ChatSkillOption[] {
  const byName = new Map(catalog.map((item) => [item.name, item]));
  return names.map((name) => {
    const meta = byName.get(name);
    const triggers = (meta?.triggers ?? []).map((item) => item.trim()).filter(Boolean);
    const hint = (
      meta?.when?.trim() ||
      meta?.description?.trim() ||
      meta?.selection?.trim() ||
      triggers.slice(0, 2).join(" / ")
    ).trim();
    const keywords = [meta?.when, meta?.description, meta?.selection, ...triggers]
      .map((item) => item?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    return {
      name,
      label: skillLabel(name, meta?.display_name),
      hint,
      keywords,
    };
  });
}

/** 写入输入框的 @ 标记。展示名含空格时退回技能标识，避免截断。 */
export function skillMentionToken(skill: ChatSkillOption): string {
  if (/[\s@]/.test(skill.label)) return skill.name;
  return skill.label;
}

export function extractMentionedSkillNames(text: string, skills: ChatSkillOption[]): string[] {
  const tokens = [...text.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? "");
  const found: string[] = [];
  for (const token of tokens) {
    const hit = skills.find(
      (skill) =>
        skill.name === token || skill.label === token || skillMentionToken(skill) === token,
    );
    if (hit && !found.includes(hit.name)) found.push(hit.name);
  }
  return found;
}

export function filterSkillMentions(skills: ChatSkillOption[], query: string, limit = 8): ChatSkillOption[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? skills.filter((skill) =>
        `${skill.name} ${skill.label} ${skill.hint} ${skill.keywords}`.toLowerCase().includes(q),
      )
    : skills;
  return matched.slice(0, limit);
}
