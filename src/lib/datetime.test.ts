import { describe, expect, it } from "vitest";

import { APP_TIME_ZONE, formatDateTimeShanghai } from "@/lib/datetime";

describe("formatDateTimeShanghai", () => {
  it("uses Asia/Shanghai timezone", () => {
    expect(APP_TIME_ZONE).toBe("Asia/Shanghai");
  });

  it("formats UTC instant as Shanghai local time", () => {
    // 2026-07-02 01:05 UTC = 2026-07-02 09:05 CST
    const text = formatDateTimeShanghai("2026-07-02T01:05:00.000Z");
    expect(text).toContain("2026");
    expect(text).toMatch(/09:05|9:05/);
  });

  it("returns fallback for empty values", () => {
    expect(formatDateTimeShanghai(null)).toBe("未记录");
    expect(formatDateTimeShanghai(undefined, "—")).toBe("—");
  });
});
