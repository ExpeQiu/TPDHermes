export type BrainstormStopInput = {
  consensus_reached?: boolean | null;
  stopped_at_round?: number | null;
  discussion_mode?: string | null;
};

/** 结束原因单独成句，和发言轨迹分开，确认写入前展示。 */
export function brainstormStopReason(result: BrainstormStopInput): string {
  if (result.consensus_reached) {
    const round = result.stopped_at_round ?? "?";
    return `共识提前收束（第 ${round} 轮）`;
  }
  if (result.discussion_mode === "debate") {
    return "辩论按轮次结束，裁判结论留在发言记录里";
  }
  if (Number(result.stopped_at_round) > 0) {
    return `按预定轮次结束（第 ${result.stopped_at_round} 轮）`;
  }
  return "圆桌已结束";
}
