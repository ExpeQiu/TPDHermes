import { describe, expect, it } from "vitest";

import { parseTpHermesStreamMeta } from "@/lib/chat-citations";

describe("parseTpHermesStreamMeta", () => {
  it("maps file tool events from tphermes_task meta", () => {
    const meta = parseTpHermesStreamMeta(
      JSON.stringify({
        tphermes_task: {
          run_id: "run-1",
          tool_events: [
            {
              toolCallId: "call-1",
              tool: "write_file",
              status: "running",
              label: "docs/prd.md",
              emoji: "✍️",
            },
            {
              toolCallId: "call-2",
              tool: "patch",
              status: "completed",
              label: "docs/report.md",
            },
            {
              toolCallId: "call-3",
              tool: "web_search",
              status: "running",
              label: "ignored",
            },
          ],
        },
      }),
    );

    expect(meta?.runId).toBe("run-1");
    expect(meta?.toolEvents).toEqual([
      {
        toolCallId: "call-1",
        toolName: "write_file",
        status: "running",
        label: "docs/prd.md",
        emoji: "✍️",
        path: "docs/prd.md",
      },
      {
        toolCallId: "call-2",
        toolName: "patch",
        status: "completed",
        label: "docs/report.md",
        emoji: undefined,
        path: "docs/report.md",
      },
    ]);
  });
});
