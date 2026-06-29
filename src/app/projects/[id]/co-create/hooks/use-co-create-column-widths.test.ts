import { beforeEach, describe, expect, it } from "vitest";

import { act, renderHook, waitFor } from "@/test-utils/hook-test-utils";
import {
  CO_CREATE_COLUMN_MIN,
  fitWidthsToContainer,
  useCoCreateColumnWidths,
} from "./use-co-create-column-widths";

const STORAGE_KEY = "tphermes-co-create-column-widths-v2";

describe("fitWidthsToContainer", () => {
  it("scales columns to fill the container width", () => {
    const fitted = fitWidthsToContainer(
      { session: 224, message: 360, preview: 360, files: 256 },
      1200,
      { sidebarOpen: true, filesPanelOpen: true },
    );
    const total = fitted.session + fitted.message + fitted.preview + fitted.files;
    expect(total).toBe(1200);
  });

  it("ignores session width when the sidebar is collapsed", () => {
    const fitted = fitWidthsToContainer(
      { session: 224, message: 360, preview: 360, files: 256 },
      1000,
      { sidebarOpen: false, filesPanelOpen: true },
    );
    const total = fitted.message + fitted.preview + fitted.files;
    expect(total).toBe(1000);
    expect(fitted.session).toBe(224);
  });

  it("ignores files width when the files panel is collapsed", () => {
    const fitted = fitWidthsToContainer(
      { session: 224, message: 360, preview: 360, files: 256 },
      1000,
      { sidebarOpen: true, filesPanelOpen: false },
    );
    const total = fitted.session + fitted.message + fitted.preview;
    expect(total).toBe(1000);
    expect(fitted.files).toBe(256);
  });
});

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
      ({ visibility }: { visibility: { sidebarOpen: boolean; filesPanelOpen: boolean } }) =>
        useCoCreateColumnWidths(visibility),
      { initialProps: { visibility: { sidebarOpen: true, filesPanelOpen: true } } },
    );

    await waitFor(() => {
      expect(result.current.widths).toEqual(CO_CREATE_COLUMN_MIN);
    });
    expect(result.current.sessionWidth).toBe(CO_CREATE_COLUMN_MIN.session);
    expect(result.current.filesWidth).toBe(CO_CREATE_COLUMN_MIN.files);

    rerender({ visibility: { sidebarOpen: false, filesPanelOpen: true } });
    expect(result.current.sessionWidth).toBe(0);

    rerender({ visibility: { sidebarOpen: false, filesPanelOpen: false } });
    expect(result.current.filesWidth).toBe(0);
  });

  it("adjusts adjacent widths within bounds and persists the latest state", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        session: 200,
        message: 360,
        preview: 360,
        files: 240,
      }),
    );

    const { result } = renderHook(() =>
      useCoCreateColumnWidths({ sidebarOpen: true, filesPanelOpen: true }),
    );

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
      session: 200,
      message: 500,
      preview: CO_CREATE_COLUMN_MIN.preview,
      files: 240,
    });
  });
});
