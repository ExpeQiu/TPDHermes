type TurnClockMessage = {
  id: string;
  role: string;
  createdAt?: number;
};

/** 已结束 · 2 分 34 秒 */
export function formatTurnDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

/** 对话短号，取会话 id 前 8 位 */
export function shortConversationId(sessionId: string | null | undefined): string {
  const compact = (sessionId ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return compact.slice(0, 8);
}

export function turnStartedAtMs(messages: TurnClockMessage[], messageId: string): number | null {
  const index = messages.findIndex((item) => item.id === messageId);
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prior = messages[i];
    if (prior?.role === "user" && typeof prior.createdAt === "number") return prior.createdAt;
  }
  const own = messages[index]?.createdAt;
  return typeof own === "number" ? own : null;
}

export function measureTurnElapsedMs(
  messages: TurnClockMessage[],
  assistantId: string,
  finishedAt: number,
): number | null {
  const started = turnStartedAtMs(messages, assistantId);
  if (started == null) return null;
  return Math.max(0, finishedAt - started);
}
