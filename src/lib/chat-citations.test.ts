import { describe, expect, it } from "vitest";

import { mergeStreamContent, parseTpHermesStreamMeta } from "@/lib/chat-citations";

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

  it("maps empty_content and stream_error from tphermes_task meta", () => {
    const meta = parseTpHermesStreamMeta(
      JSON.stringify({
        tphermes_task: {
          run_id: "run-empty",
          status: "failed",
          empty_content: true,
          stream_error: "Agent 未返回可见正文",
        },
      }),
    );

    expect(meta?.runId).toBe("run-empty");
    expect(meta?.emptyContent).toBe(true);
    expect(meta?.streamError).toBe("Agent 未返回可见正文");
    expect(meta?.runStatus).toBe("failed");
  });

  it("replaces streamed text instead of appending a second body", () => {
    const meta = parseTpHermesStreamMeta(
      JSON.stringify({
        tphermes_task: {
          content_replace: "最终成稿",
          delivery_status: "degraded",
          fallback_reason: "agent_tool_miss",
        },
      }),
    );
    expect(mergeStreamContent("Agent 先说了一段", meta, "")).toBe("最终成稿");
    expect(meta?.deliveryStatus).toBe("degraded");
    expect(meta?.fallbackReason).toBe("agent_tool_miss");
  });
});
