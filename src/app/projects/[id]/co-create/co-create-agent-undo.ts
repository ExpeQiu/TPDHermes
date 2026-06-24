"use client";

/** Agent 自动/审阅 apply 后可撤销的单条记录 */
export type AgentUndoEntry =
  | {
      type: "create";
      proposalId: string;
      fileId: string;
      fileName: string;
      appliedAt?: number;
    }
  | {
      type: "patch";
      proposalId: string;
      fileId: string;
      fileKind: "output" | "attachment";
      fileName: string;
      previousContent: string;
      appliedAt?: number;
    };

export const MAX_AGENT_UNDO_STACK = 20;

export function parseAgentUndoStack(raw: unknown): AgentUndoEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentUndoEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const type = row.type;
    const proposalId = String(row.proposalId ?? row.proposal_id ?? "");
    const fileId = String(row.fileId ?? row.file_id ?? "");
    const fileName = String(row.fileName ?? row.file_name ?? "");
    if (!proposalId || !fileId || !fileName) continue;
    const appliedAt = typeof row.appliedAt === "number" ? row.appliedAt : undefined;
    if (type === "create") {
      out.push({ type: "create", proposalId, fileId, fileName, appliedAt });
    } else if (type === "patch") {
      const fileKind = row.fileKind ?? row.file_kind;
      if (fileKind !== "output" && fileKind !== "attachment") continue;
      const previousContent = String(row.previousContent ?? row.previous_content ?? "");
      out.push({
        type: "patch",
        proposalId,
        fileId,
        fileKind,
        fileName,
        previousContent,
        appliedAt,
      });
    }
  }
  return out.slice(-MAX_AGENT_UNDO_STACK);
}

export function pushAgentUndoStack(
  stack: AgentUndoEntry[],
  entry: AgentUndoEntry,
): AgentUndoEntry[] {
  const stamped: AgentUndoEntry = {
    ...entry,
    appliedAt: entry.appliedAt ?? Date.now(),
  };
  const withoutDup = stack.filter((item) => item.proposalId !== stamped.proposalId);
  return [...withoutDup, stamped].slice(-MAX_AGENT_UNDO_STACK);
}

export function popAgentUndoStack(stack: AgentUndoEntry[]): {
  next: AgentUndoEntry[];
  popped: AgentUndoEntry | null;
} {
  if (stack.length === 0) return { next: [], popped: null };
  const popped = stack[stack.length - 1] ?? null;
  return { next: stack.slice(0, -1), popped };
}

export function formatAgentUndoButtonLabel(stackSize: number): string {
  if (stackSize <= 0) return "撤销";
  return stackSize > 1 ? `撤销 (${stackSize})` : "撤销";
}

export function formatAgentUndoSummary(
  stack: AgentUndoEntry[],
  options?: { applyMode?: "auto" | "review"; agentMode?: "ask" | "agent" | "plan" },
): string | null {
  if (options?.agentMode === "ask") return "Ask 只读模式，不会写回文件";
  if (stack.length === 0) {
    if (options?.applyMode === "review") return "审阅模式：文件变更需人工确认";
    return null;
  }
  const latest = stack[stack.length - 1];
  const countHint = stack.length > 1 ? `（共 ${stack.length} 项可撤销）` : "";
  const action =
    latest.type === "create"
      ? `Agent 已创建 ${latest.fileName}`
      : `Agent 已修改 ${latest.fileName}`;
  if (options?.applyMode === "review") {
    return `审阅模式 · ${action}${countHint}`;
  }
  return `${action}，已自动保存${countHint}`;
}
