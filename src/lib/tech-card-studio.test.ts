import { describe, expect, it } from "vitest";

import {
  SOURCE_TEXT,
  applyStudioCommand,
  createStudioState,
  emptyFields,
  quoteFor,
  selectCardField,
} from "./tech-card-studio";

describe("tech card studio", () => {
  it("extracts cards with source quotes and leaves undocumented fields empty", () => {
    const result = applyStudioCommand(createStudioState(), "提取技术卡");
    expect(result.log.ok).toBe(true);
    expect(result.log.operation).toBe("extract");
    expect(result.state.cards).toHaveLength(4);
    for (const card of result.state.cards) {
      const quote = quoteFor(card, "definition");
      expect(SOURCE_TEXT).toContain(quote);
    }
    const platform = result.state.cards.find((card) => card.term === "800V 高压平台");
    expect(platform?.parameter).toBe("800 伏");
    expect(platform?.scope).toBe("");
    expect(emptyFields(platform!).map((field) => field)).toContain("scope");
  });

  it("keeps a locked card unchanged when extracting again", () => {
    const extracted = applyStudioCommand(createStudioState(), "提取技术卡").state;
    const selected = selectCardField(extracted, extracted.cards[0].id, "definition");
    const locked = applyStudioCommand(selected, "锁定当前卡").state;
    const lockedCard = locked.cards.find((card) => card.status === "locked");
    expect(lockedCard).toBeTruthy();

    const again = applyStudioCommand(locked, "再提取一次").state;
    const kept = again.cards.find((card) => card.id === lockedCard!.id);
    expect(kept).toEqual(lockedCard);
    expect(again.cards.filter((card) => card.status === "candidate").every((card) => card.id !== lockedCard!.id)).toBe(
      true,
    );
    expect(again.revision).toBe(locked.revision + 1);
  });

  it("merges same-domain synonyms and refuses cross-domain or locked cards", () => {
    const extracted = applyStudioCommand(createStudioState(), "提取技术卡").state;
    const merged = applyStudioCommand(extracted, "合并同域");
    expect(merged.log.ok).toBe(true);
    expect(merged.state.cards.some((card) => card.term === "SiC 逆变器")).toBe(false);
    const combined = merged.state.cards.find((card) => card.term === "碳化硅功率模块");
    expect(combined?.aliases).toContain("SiC 逆变器");
    expect(combined?.scope).toBe("");
    expect(SOURCE_TEXT).toContain(quoteFor(combined!, "definition"));

    const blocked = applyStudioCommand(extracted, "合并氛围灯");
    expect(blocked.log.ok).toBe(false);
    expect(blocked.state.cards).toEqual(extracted.cards);
    expect(blocked.state.blockedReason).toContain("跨域");

    const selected = selectCardField(extracted, extracted.cards.find((card) => card.term === "SiC 逆变器")!.id, "definition");
    const locked = applyStudioCommand(selected, "锁定").state;
    const refused = applyStudioCommand(locked, "合并同域");
    expect(refused.log.ok).toBe(false);
    expect(refused.state.cards).toEqual(locked.cards);
  });
});
