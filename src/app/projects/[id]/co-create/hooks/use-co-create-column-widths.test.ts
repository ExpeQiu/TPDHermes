import { beforeEach, describe, expect, it } from "vitest";

import { act, renderHook, waitFor } from "@/test-utils/hook-test-utils";
import {
  CO_CREATE_COLUMN_MIN,
  useCoCreateColumnWidths,
} from "./use-co-create-column-widths";

const STORAGE_KEY = "tphermes-co-create-column-widths-v2";

describe("useCoCreateColumnWidths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("hydrates widths from storage and clamps them to the minimum values", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        session: 80,
        message: 100,
        preview: 120,
        files: 150,
      }),
    );

    const { result, rerender } = renderHook(
      ({ sidebarOpen }: { sidebarOpen: boolean }) => useCoCreateColumnWidths(sidebarOpen),
      { initialProps: { sidebarOpen: true } },
    );

    await waitFor(() => {
      expect(result.current.widths).toEqual(CO_CREATE_COLUMN_MIN);
    });
    expect(result.current.sessionWidth).toBe(CO_CREATE_COLUMN_MIN.session);

    rerender({ sidebarOpen: false });
    expect(result.current.sessionWidth).toBe(0);
  });

  it("adjusts adjacent widths within bounds and persists the latest state", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        session: 224,
        message: 360,
        preview: 360,
        files: 256,
      }),
    );

    const { result } = renderHook(() => useCoCreateColumnWidths(true));

    await waitFor(() => {
      expect(result.current.widths.message).toBe(360);
    });

    act(() => {
      result.current.adjustPair("message", "preview", 500);
    });

    expect(result.current.widths.message).toBe(500);
    expect(result.current.widths.preview).toBe(CO_CREATE_COLUMN_MIN.preview);

    act(() => {
      result.current.persistWidths();
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")).toMatchObject({
      session: 224,
      message: 500,
      preview: CO_CREATE_COLUMN_MIN.preview,
      files: 256,
    });
  });
});
