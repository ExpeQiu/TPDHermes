"use client";

import { useCallback, useEffect, useRef } from "react";

type Props = {
  onDrag: (deltaX: number) => void;
  onDragEnd?: () => void;
};

export function ColumnResizeHandle({ onDrag, onDragEnd }: Props) {
  const draggingRef = useRef(false);

  const stopDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onDragEnd?.();
  }, [onDragEnd]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      onDrag(event.movementX);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stopDrag);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, [onDrag, stopDrag]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整栏宽"
      onMouseDown={() => {
        draggingRef.current = true;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      className="group relative z-10 w-1 shrink-0 cursor-col-resize bg-slate-300/40 hover:bg-blue-500/35 active:bg-blue-500/50 dark:bg-slate-700/60"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
