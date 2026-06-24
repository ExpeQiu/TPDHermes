import { describe, expect, it } from "vitest";

import {
  formatAgentUndoButtonLabel,
  formatAgentUndoSummary,
  MAX_AGENT_UNDO_STACK,
  parseAgentUndoStack,
  popAgentUndoStack,
  pushAgentUndoStack,
} from "./co-create-agent-undo";

describe("co-create-agent-undo", () => {
  it("parseAgentUndoStack 过滤非法项并保留合法 patch/create", () => {
    const stack = parseAgentUndoStack([
      { type: "create", proposalId: "p1", fileId: "f1", fileName: "a.md" },
      { type: "patch", proposalId: "p2", fileId: "f2", fileKind: "output", fileName: "b.md", previousContent: "old" },
      { type: "unknown" },
      null,
    ]);
    expect(stack).toHaveLength(2);
    expect(stack[0]?.type).toBe("create");
    expect(stack[1]?.type).toBe("patch");
  });

  it("pushAgentUndoStack 去重 proposalId 并限制深度", () => {
    let stack = pushAgentUndoStack([], {
      type: "create",
      proposalId: "p1",
      fileId: "f1",
      fileName: "a.md",
    });
    stack = pushAgentUndoStack(stack, {
      type: "create",
      proposalId: "p1",
      fileId: "f1",
      fileName: "a2.md",
    });
    expect(stack).toHaveLength(1);
    expect(stack[0]?.fileName).toBe("a2.md");

    for (let i = 0; i < MAX_AGENT_UNDO_STACK + 5; i += 1) {
      stack = pushAgentUndoStack(stack, {
        type: "create",
        proposalId: `p-${i}`,
        fileId: `f-${i}`,
        fileName: `${i}.md`,
      });
    }
    expect(stack.length).toBe(MAX_AGENT_UNDO_STACK);
  });

  it("popAgentUndoStack 弹出栈顶", () => {
    const stack = [
      {
        type: "create" as const,
        proposalId: "p1",
        fileId: "f1",
        fileName: "a.md",
      },
      {
        type: "patch" as const,
        proposalId: "p2",
        fileId: "f2",
        fileKind: "output" as const,
        fileName: "b.md",
        previousContent: "old",
      },
    ];
    const { popped, next } = popAgentUndoStack(stack);
    expect(popped?.proposalId).toBe("p2");
    expect(next).toHaveLength(1);
  });

  it("formatAgentUndoButtonLabel 显示可撤销数量", () => {
    expect(formatAgentUndoButtonLabel(0)).toBe("撤销");
    expect(formatAgentUndoButtonLabel(1)).toBe("撤销");
    expect(formatAgentUndoButtonLabel(3)).toBe("撤销 (3)");
  });

  it("formatAgentUndoSummary 区分 ask 与有栈场景", () => {
    expect(formatAgentUndoSummary([], { agentMode: "ask" })).toContain("只读");
    expect(
      formatAgentUndoSummary(
        [
          { type: "patch", proposalId: "p1", fileId: "f", fileKind: "output", fileName: "x.md", previousContent: "" },
          { type: "create", proposalId: "p2", fileId: "f2", fileName: "y.md" },
        ],
        { applyMode: "auto" },
      ),
    ).toContain("共 2 项可撤销");
  });
});
