import { describe, expect, it } from "vitest";
import { brainstormStopReason } from "./stop-reason";

describe("brainstormStopReason", () => {
  it("区分共识提前结束和预定轮次结束", () => {
    expect(
      brainstormStopReason({ consensus_reached: true, stopped_at_round: 2 }),
    ).toBe("共识提前收束（第 2 轮）");
    expect(
      brainstormStopReason({
        discussion_mode: "round_robin",
        stopped_at_round: 3,
      }),
    ).toBe("按预定轮次结束（第 3 轮）");
    expect(brainstormStopReason({ discussion_mode: "debate" })).toContain("裁判结论");
  });
});
