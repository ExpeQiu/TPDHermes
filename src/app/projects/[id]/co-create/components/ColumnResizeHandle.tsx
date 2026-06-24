"use client";

import { useCallback, useRef } from "react";

type Props = {
  onDrag: (deltaX: number) => void;
  onDragEnd?: () => void;
  onDragStart?: () => void;
};

export function ColumnResizeHandle({ onDrag, onDragEnd, onDragStart }: Props) {
  const draggingRef = useRef(false);
  const lastXRef = useRef(0);

  const stopDrag = useCallback(
    (pointerId?: number, target?: HTMLElement | null) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      if (target && pointerId != null && target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整栏宽"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        draggingRef.current = true;
        lastXRef.current = event.clientX;
        onDragStart?.();
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        const delta = event.clientX - lastXRef.current;
        lastXRef.current = event.clientX;
        if (delta !== 0) onDrag(delta);
      }}
      onPointerUp={(event) => {
        stopDrag(event.pointerId, event.currentTarget);
      }}
      onPointerCancel={(event) => {
        stopDrag(event.pointerId, event.currentTarget);
      }}
      onLostPointerCapture={(event) => {
        stopDrag(event.pointerId, event.currentTarget);
      }}
      className="group absolute top-0 left-0 z-30 h-full w-3 -translate-x-1/2 cursor-col-resize touch-none select-none hover:bg-blue-500/15 active:bg-blue-500/25"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-300 group-hover:bg-blue-400 group-active:bg-blue-500 dark:bg-slate-600 dark:group-hover:bg-blue-400"
      />
    </div>
  );
}
