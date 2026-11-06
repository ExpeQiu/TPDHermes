import { describe, expect, it } from "vitest";

import { activityLevel, buildActivityCalendar } from "./project-activity-calendar";

describe("project activity calendar", () => {
  it("scales a lone active day up to the brightest level", () => {
    expect(activityLevel(0, 4)).toBe(0);
    expect(activityLevel(1, 1)).toBe(4);
    expect(activityLevel(1, 8)).toBe(1);
    expect(activityLevel(6, 8)).toBe(4);
  });

  it("builds 53 Monday-first weeks and only counts the selected window", () => {
    const calendar = buildActivityCalendar(
      [
        { date: "2026-11-06", count: 3 },
        { date: "2025-01-02", count: 9 },
        { date: "2024-12-30", count: 4 },
      ],
      2026,
      "2026-11-06",
    );

    expect(calendar.weeks).toHaveLength(53);
    expect(calendar.weeks[0]?.days).toHaveLength(7);
    const first = calendar.weeks[0]?.days[0]?.date ?? "";
    const [year, month, day] = first.split("-").map(Number);
    expect(new Date(Date.UTC(year, month - 1, day)).getUTCDay()).toBe(1);
    expect(calendar.label).toBe("最近一年");
    expect(calendar.total).toBe(3);
    expect(calendar.years).toEqual([2026, 2025, 2024]);

    const lit = calendar.weeks.flatMap((week) => week.days).find((cell) => cell.date === "2026-11-06");
    expect(lit?.count).toBe(3);
    expect(lit?.level).toBe(4);

    const future = calendar.weeks.at(-1)?.days.find((cell) => cell.date === "2026-11-08");
    expect(future?.inRange).toBe(false);
    expect(future?.count).toBe(0);
  });

  it("keeps spillover weeks outside a past calendar year uncounted", () => {
    const calendar = buildActivityCalendar(
      [{ date: "2024-12-30", count: 4 }, { date: "2025-01-02", count: 2 }],
      2025,
      "2026-11-06",
    );

    expect(calendar.label).toBe("2025年");
    expect(calendar.total).toBe(2);
    const spill = calendar.weeks[0]?.days.find((cell) => cell.date === "2024-12-30");
    expect(spill?.inRange).toBe(false);
    expect(calendar.weeks[0]?.monthLabel).toBe("12月");
  });
});
