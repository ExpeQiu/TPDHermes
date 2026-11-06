import { describe, expect, it } from "vitest";

import {
  formatTurnDuration,
  measureTurnElapsedMs,
  shortConversationId,
} from "@/lib/turn-duration";

describe("formatTurnDuration", () => {
  it("formats seconds, minutes, and hours like the chat footer", () => {
    expect(formatTurnDuration(0)).toBe("0 秒");
    expect(formatTurnDuration(12)).toBe("12 秒");
    expect(formatTurnDuration(154)).toBe("2 分 34 秒");
    expect(formatTurnDuration(3723)).toBe("1 小时 2 分 3 秒");
  });
});

describe("shortConversationId", () => {
  it("keeps the first 8 alphanumeric characters", () => {
    expect(shortConversationId("d61c967c-1234")).toBe("d61c967c");
    expect(shortConversationId("")).toBe("");
  });
});

describe("measureTurnElapsedMs", () => {
  it("counts from the preceding user message", () => {
    const elapsed = measureTurnElapsedMs(
      [
        { id: "u", role: "user", createdAt: 1_000 },
        { id: "a", role: "assistant", createdAt: 1_500 },
      ],
      "a",
      3_400,
    );
    expect(elapsed).toBe(2_400);
  });
});
