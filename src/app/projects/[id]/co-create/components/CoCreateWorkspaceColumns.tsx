"use client";

import type { ReactNode } from "react";

import { ColumnResizeHandle } from "@/app/projects/[id]/co-create/components/ColumnResizeHandle";
import {
  useCoCreateColumnWidths,
  type CoCreateColumnWidths,
} from "@/app/projects/[id]/co-create/hooks/use-co-create-column-widths";

type Props = {
  sidebarOpen: boolean;
  session: ReactNode;
  message: ReactNode;
  preview: ReactNode;
  files: ReactNode;
};

export function CoCreateWorkspaceColumns({
  sidebarOpen,
  session,
  message,
  preview,
  files,
}: Props) {
  const { containerRef, widths, sessionWidth, adjustPair, persistWidths } =
    useCoCreateColumnWidths(sidebarOpen);

  const bindResize = (left: keyof CoCreateColumnWidths, right: keyof CoCreateColumnWidths) => ({
    onDrag: (delta: number) => adjustPair(left, right, delta),
    onDragEnd: persistWidths,
  });

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      {sidebarOpen ? (
        <>
          <div
            className="min-h-0 shrink-0 overflow-hidden"
            style={{ width: sessionWidth }}
          >
            {session}
          </div>
          <ColumnResizeHandle {...bindResize("session", "message")} />
        </>
      ) : null}

      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{ width: widths.message }}
      >
        {message}
      </div>

      <ColumnResizeHandle {...bindResize("message", "preview")} />

      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{ width: widths.preview }}
      >
        {preview}
      </div>

      <ColumnResizeHandle {...bindResize("preview", "files")} />

      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{ width: widths.files }}
      >
        {files}
      </div>
    </div>
  );
}
