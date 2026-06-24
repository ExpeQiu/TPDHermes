"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type CoCreateColumnWidths = {
  session: number;
  message: number;
  preview: number;
  files: number;
};

const STORAGE_KEY = "tphermes-co-create-column-widths-v2";
const HANDLE_WIDTH = 4;

export const CO_CREATE_COLUMN_MIN: CoCreateColumnWidths = {
  session: 160,
  message: 220,
  preview: 220,
  files: 200,
};

export const CO_CREATE_COLUMN_DEFAULT: CoCreateColumnWidths = {
  session: 224,
  message: 360,
  preview: 360,
  files: 256,
};

function loadStoredWidths(): CoCreateColumnWidths | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CoCreateColumnWidths>;
    if (
      typeof parsed.session === "number" &&
      typeof parsed.message === "number" &&
      typeof parsed.preview === "number" &&
      typeof parsed.files === "number"
    ) {
      return {
        session: Math.max(CO_CREATE_COLUMN_MIN.session, parsed.session),
        message: Math.max(CO_CREATE_COLUMN_MIN.message, parsed.message),
        preview: Math.max(CO_CREATE_COLUMN_MIN.preview, parsed.preview),
        files: Math.max(CO_CREATE_COLUMN_MIN.files, parsed.files),
      };
    }
  } catch {
    // ignore invalid cache
  }
  return null;
}

function saveWidths(widths: CoCreateColumnWidths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // ignore quota errors
  }
}

function splitMiddleColumns(totalWidth: number): Pick<CoCreateColumnWidths, "message" | "preview"> {
  const reserved =
    CO_CREATE_COLUMN_DEFAULT.session +
    CO_CREATE_COLUMN_DEFAULT.files +
    HANDLE_WIDTH * 3;
  const remainder = Math.max(
    CO_CREATE_COLUMN_MIN.message + CO_CREATE_COLUMN_MIN.preview,
    totalWidth - reserved,
  );
  const message = Math.max(CO_CREATE_COLUMN_MIN.message, Math.floor(remainder / 2));
  const preview = Math.max(CO_CREATE_COLUMN_MIN.preview, remainder - message);
  return { message, preview };
}

export function useCoCreateColumnWidths(sidebarOpen: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const [widths, setWidths] = useState(CO_CREATE_COLUMN_DEFAULT);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  useLayoutEffect(() => {
    if (initializedRef.current) return;

    const initFromContainer = () => {
      const stored = loadStoredWidths();
      if (stored) {
        setWidths(stored);
        initializedRef.current = true;
        return true;
      }
      const total = containerRef.current?.clientWidth ?? 0;
      if (total <= 0) return false;
      const middle = splitMiddleColumns(total);
      setWidths({
        session: CO_CREATE_COLUMN_DEFAULT.session,
        files: CO_CREATE_COLUMN_DEFAULT.files,
        ...middle,
      });
      initializedRef.current = true;
      return true;
    };

    if (initFromContainer()) return;
    const frame = requestAnimationFrame(() => {
      initFromContainer();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const persistWidths = useCallback(() => {
    saveWidths(widthsRef.current);
  }, []);

  const adjustPair = useCallback(
    (left: keyof CoCreateColumnWidths, right: keyof CoCreateColumnWidths, delta: number) => {
      setWidths((prev) => {
        const maxLeft = prev[left] + prev[right] - CO_CREATE_COLUMN_MIN[right];
        const nextLeft = Math.min(
          Math.max(prev[left] + delta, CO_CREATE_COLUMN_MIN[left]),
          maxLeft,
        );
        const applied = nextLeft - prev[left];
        if (applied === 0) return prev;
        return {
          ...prev,
          [left]: nextLeft,
          [right]: prev[right] - applied,
        };
      });
    },
    [],
  );

  const sessionWidth = sidebarOpen ? widths.session : 0;

  return {
    containerRef,
    widths,
    sessionWidth,
    adjustPair,
    persistWidths,
  };
}
