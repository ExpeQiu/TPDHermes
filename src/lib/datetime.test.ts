import { describe, expect, it } from "vitest";

import { APP_TIME_ZONE, formatDateTimeShanghai, formatMessageTimestamp } from "@/lib/datetime";

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

describe("formatMessageTimestamp", () => {
  it("formats as YYYY-MM-DD HH:mm in Asia/Shanghai", () => {
    // 2026-07-20 06:55 UTC = 2026-07-20 14:55 CST
    expect(formatMessageTimestamp("2026-07-20T06:55:00.000Z")).toBe("2026-07-20 14:55");
    expect(formatMessageTimestamp(Date.parse("2026-07-20T06:55:00.000Z"))).toBe("2026-07-20 14:55");
  });

  it("returns null for empty values", () => {
    expect(formatMessageTimestamp(null)).toBeNull();
    expect(formatMessageTimestamp(undefined)).toBeNull();
  });
});