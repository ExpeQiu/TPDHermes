import { describe, expect, it } from "vitest";

import { selectionMenuPosition } from "@/app/projects/[id]/co-create/components/FilePreviewPanel";

function mockContainer(overrides: Partial<HTMLElement> = {}): HTMLElement {
  return {
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 800,
    scrollHeight: 2400,
    clientHeight: 600,
    getBoundingClientRect: () => ({
      left: 700,
      top: 120,
      width: 520,
      height: 600,
      right: 1220,
      bottom: 720,
      x: 700,
      y: 120,
      toJSON: () => ({}),
    }),
    ...overrides,
  } as HTMLElement;
}

function mockRange(rect: Partial<DOMRect>): Range {
  return {
    getBoundingClientRect: () => ({
      left: 720,
      top: 520,
      width: 280,
      height: 18,
      right: 1000,
      bottom: 538,
      x: 720,
      y: 520,
      toJSON: () => ({}),
      ...rect,
    }),
  } as Range;
}

describe("selectionMenuPosition", () => {
  it("滚动后仍锚定在选区下方", () => {
    const container = mockContainer({ scrollTop: 420 });
    const range = mockRange({ left: 720, top: 520, bottom: 538, width: 280, height: 18 });

    const pos = selectionMenuPosition(container, 900, 535, range);

    // 选区 bottom(538) - container top(120) + scrollTop(420) + gap(8) ≈ 846
    expect(pos.y).toBeGreaterThan(800);
    expect(pos.y).toBeLessThan(900);
  });

  it("未滚动时贴近选区", () => {
    const container = mockContainer({ scrollTop: 0 });
    const range = mockRange({ left: 720, top: 220, bottom: 238, width: 200, height: 18 });

    const pos = selectionMenuPosition(container, 820, 235, range);

    expect(pos.y).toBeGreaterThan(100);
    expect(pos.y).toBeLessThan(180);
  });
});
