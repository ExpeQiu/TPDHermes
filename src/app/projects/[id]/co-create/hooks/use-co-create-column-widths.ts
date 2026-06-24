"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type CoCreateColumnWidths = {
  session: number;
  message: number;
  preview: number;
  files: number;
};

const STORAGE_KEY = "tphermes-co-create-column-widths-v2";

export const CO_CREATE_COLUMN_MIN: CoCreateColumnWidths = {
  session: 160,
  message: 220,
  preview: 220,
  files: 200,
};

export const CO_CREATE_COLUMN_DEFAULT: CoCreateColumnWidths = {
  session: 200,
  message: 360,
  preview: 360,
  files: 240,
};

function visibleKeys(sidebarOpen: boolean): (keyof CoCreateColumnWidths)[] {
  return sidebarOpen
    ? ["session", "message", "preview", "files"]
    : ["message", "preview", "files"];
}

function sumVisible(widths: CoCreateColumnWidths, sidebarOpen: boolean) {
  return visibleKeys(sidebarOpen).reduce((total, key) => total + widths[key], 0);
}

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

function distributeDefaults(
  available: number,
  sidebarOpen: boolean,
): CoCreateColumnWidths {
  const session = sidebarOpen ? CO_CREATE_COLUMN_DEFAULT.session : 0;
  const files = CO_CREATE_COLUMN_DEFAULT.files;
  const middle = Math.max(
    CO_CREATE_COLUMN_MIN.message + CO_CREATE_COLUMN_MIN.preview,
    available - session - files,
  );
  const message = Math.max(CO_CREATE_COLUMN_MIN.message, Math.floor(middle / 2));
  const preview = Math.max(CO_CREATE_COLUMN_MIN.preview, middle - message);
  return {
    session: sidebarOpen ? session : CO_CREATE_COLUMN_DEFAULT.session,
    message,
    preview,
    files: Math.max(
      CO_CREATE_COLUMN_MIN.files,
      Math.min(files, available - session - message - preview),
    ),
  };
}

/** 将可见列宽总和对齐到容器可用宽度，同时尊重各列最小值 */
export function fitWidthsToContainer(
  widths: CoCreateColumnWidths,
  containerWidth: number,
  sidebarOpen: boolean,
): CoCreateColumnWidths {
  const keys = visibleKeys(sidebarOpen);
  const minSum = keys.reduce((total, key) => total + CO_CREATE_COLUMN_MIN[key], 0);
  const available = Math.max(minSum, containerWidth);

  const currentSum = sumVisible(widths, sidebarOpen);
  const next: CoCreateColumnWidths = { ...widths };

  if (currentSum <= 0) {
    const defaults = distributeDefaults(available, sidebarOpen);
    if (!sidebarOpen) {
      return { ...defaults, session: widths.session || CO_CREATE_COLUMN_DEFAULT.session };
    }
    return defaults;
  }

  if (currentSum === available) {
    return next;
  }

  const scale = available / currentSum;
  for (const key of keys) {
    next[key] = Math.max(CO_CREATE_COLUMN_MIN[key], Math.round(widths[key] * scale));
  }

  let diff = available - sumVisible(next, sidebarOpen);
  const flexKeys: (keyof CoCreateColumnWidths)[] = ["message", "preview"];
  while (diff !== 0) {
    const step = diff > 0 ? 1 : -1;
    const target = flexKeys.find((key) => next[key] + step >= CO_CREATE_COLUMN_MIN[key]);
    if (!target) break;
    next[target] += step;
    diff -= step;
  }

  return next;
}

export function useCoCreateColumnWidths(sidebarOpen: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;

  const [widths, setWidths] = useState(CO_CREATE_COLUMN_DEFAULT);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const syncToContainer = useCallback((containerWidth: number, open = sidebarOpenRef.current) => {
    if (containerWidth <= 0) return;
    setWidths((prev) => fitWidthsToContainer(prev, containerWidth, open));
  }, []);

  useLayoutEffect(() => {
    const stored = loadStoredWidths();
    const node = containerRef.current;

    const init = () => {
      const containerWidth = node?.clientWidth ?? 0;
      const base = stored ?? CO_CREATE_COLUMN_DEFAULT;

      if (containerWidth <= 0) {
        if (stored) {
          setWidths(stored);
          return true;
        }
        return false;
      }

      setWidths(fitWidthsToContainer(base, containerWidth, sidebarOpenRef.current));
      return true;
    };

    if (!node) {
      if (stored) setWidths(stored);
      return;
    }

    let frame = 0;
    if (!init()) {
      frame = requestAnimationFrame(init);
    }

    const observer = new ResizeObserver((entries) => {
      if (draggingRef.current) return;
      const containerWidth = entries[0]?.contentRect.width ?? node.clientWidth;
      syncToContainer(containerWidth);
    });
    observer.observe(node);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [syncToContainer]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node || draggingRef.current) return;
    syncToContainer(node.clientWidth, sidebarOpen);
  }, [sidebarOpen, syncToContainer]);

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
    draggingRef,
  };
}
