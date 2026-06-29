"use client";

import type { ReactNode } from "react";

import { ColumnResizeHandle } from "@/app/projects/[id]/co-create/components/ColumnResizeHandle";
import {
  useCoCreateColumnWidths,
  type CoCreateColumnWidths,
  type CoCreatePanelVisibility,
} from "@/app/projects/[id]/co-create/hooks/use-co-create-column-widths";

type Props = CoCreatePanelVisibility & {
  session: ReactNode;
  message: ReactNode;
  preview: ReactNode;
  files: ReactNode;
};

export function CoCreateWorkspaceColumns({
  sidebarOpen,
  filesPanelOpen,
  session,
  message,
  preview,
  files,
}: Props) {
  const visibility = { sidebarOpen, filesPanelOpen };
  const { containerRef, widths, sessionWidth, filesWidth, adjustPair, persistWidths, draggingRef } =
    useCoCreateColumnWidths(visibility);

  const bindResize = (left: keyof CoCreateColumnWidths, right: keyof CoCreateColumnWidths) => ({
    onDragStart: () => {
      draggingRef.current = true;
    },
    onDrag: (delta: number) => adjustPair(left, right, delta),
    onDragEnd: () => {
      draggingRef.current = false;
      persistWidths();
    },
  });

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      {sidebarOpen ? (
        <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: sessionWidth }}>
          {session}
        </div>
      ) : null}

      <div
        className="relative min-h-0 shrink-0"
        style={{ width: widths.message }}
      >
        {sidebarOpen ? (
          <ColumnResizeHandle {...bindResize("session", "message")} />
        ) : null}
        <div className="flex h-full min-h-0 flex-col overflow-hidden">{message}</div>
      </div>

      <div
        className="relative min-h-0 shrink-0"
        style={{ width: widths.preview }}
      >
        <ColumnResizeHandle {...bindResize("message", "preview")} />
        <div className="h-full overflow-hidden">{preview}</div>
      </div>

      {filesPanelOpen ? (
        <div
          className="relative min-h-0 shrink-0"
          style={{ width: filesWidth }}
        >
          <ColumnResizeHandle {...bindResize("preview", "files")} />
          <div className="h-full overflow-hidden">{files}</div>
        </div>
      ) : null}
    </div>
  );
}
