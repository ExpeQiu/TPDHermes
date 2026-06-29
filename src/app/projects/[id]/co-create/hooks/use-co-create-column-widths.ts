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

export type CoCreatePanelVisibility = {
  sidebarOpen: boolean;
  filesPanelOpen: boolean;
};

function visibleKeys({
  sidebarOpen,
  filesPanelOpen,
}: CoCreatePanelVisibility): (keyof CoCreateColumnWidths)[] {
  const keys: (keyof CoCreateColumnWidths)[] = [];
  if (sidebarOpen) keys.push("session");
  keys.push("message", "preview");
  if (filesPanelOpen) keys.push("files");
  return keys;
}

function sumVisible(widths: CoCreateColumnWidths, visibility: CoCreatePanelVisibility) {
  return visibleKeys(visibility).reduce((total, key) => total + widths[key], 0);
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
  visibility: CoCreatePanelVisibility,
): CoCreateColumnWidths {
  const { sidebarOpen, filesPanelOpen } = visibility;
  const session = sidebarOpen ? CO_CREATE_COLUMN_DEFAULT.session : 0;
  const files = filesPanelOpen ? CO_CREATE_COLUMN_DEFAULT.files : 0;
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
    files: filesPanelOpen
      ? Math.max(
          CO_CREATE_COLUMN_MIN.files,
          Math.min(CO_CREATE_COLUMN_DEFAULT.files, available - session - message - preview),
        )
      : CO_CREATE_COLUMN_DEFAULT.files,
  };
}

/** 将可见列宽总和对齐到容器可用宽度，同时尊重各列最小值 */
export function fitWidthsToContainer(
  widths: CoCreateColumnWidths,
  containerWidth: number,
  visibility: CoCreatePanelVisibility,
): CoCreateColumnWidths {
  const keys = visibleKeys(visibility);
  const minSum = keys.reduce((total, key) => total + CO_CREATE_COLUMN_MIN[key], 0);
  const available = Math.max(minSum, containerWidth);

  const currentSum = sumVisible(widths, visibility);
  const next: CoCreateColumnWidths = { ...widths };

  if (currentSum <= 0) {
    const defaults = distributeDefaults(available, visibility);
    return {
      ...defaults,
      ...(!visibility.sidebarOpen
        ? { session: widths.session || CO_CREATE_COLUMN_DEFAULT.session }
        : {}),
      ...(!visibility.filesPanelOpen
        ? { files: widths.files || CO_CREATE_COLUMN_DEFAULT.files }
        : {}),
    };
  }

  if (currentSum === available) {
    return next;
  }

  const scale = available / currentSum;
  for (const key of keys) {
    next[key] = Math.max(CO_CREATE_COLUMN_MIN[key], Math.round(widths[key] * scale));
  }

  let diff = available - sumVisible(next, visibility);
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

export function useCoCreateColumnWidths(visibility: CoCreatePanelVisibility) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const visibilityRef = useRef(visibility);
  visibilityRef.current = visibility;

  const [widths, setWidths] = useState(CO_CREATE_COLUMN_DEFAULT);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const syncToContainer = useCallback(
    (containerWidth: number, nextVisibility = visibilityRef.current) => {
      if (containerWidth <= 0) return;
      setWidths((prev) => fitWidthsToContainer(prev, containerWidth, nextVisibility));
    },
    [],
  );

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

      setWidths(fitWidthsToContainer(base, containerWidth, visibilityRef.current));
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
    syncToContainer(node.clientWidth, visibility);
  }, [visibility.sidebarOpen, visibility.filesPanelOpen, syncToContainer]);

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

  const sessionWidth = visibility.sidebarOpen ? widths.session : 0;
  const filesWidth = visibility.filesPanelOpen ? widths.files : 0;

  return {
    containerRef,
    widths,
    sessionWidth,
    filesWidth,
    adjustPair,
    persistWidths,
    draggingRef,
  };
}
