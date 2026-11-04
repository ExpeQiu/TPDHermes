import { describe, expect, it } from "vitest";

import {
  acceptRoomPayload,
  buildRoomFileRef,
  formatElapsedSeconds,
  questionClock,
  seatedRoles,
} from "./room-client-state";

describe("room client state", () => {
  it("迟到响应只在原房间和原代次回填", () => {
    expect(acceptRoomPayload("room-a", "room-a", 1, 1)).toBe(true);
    expect(acceptRoomPayload("room-a", "room-b", 1, 2)).toBe(false);
    expect(acceptRoomPayload("room-a", "room-a", 1, 2)).toBe(false);
  });

  it("候选只保留已入座角色，解读和修改带上文件引用", () => {
    expect(seatedRoles([{ id: "writer" }, { id: "alpha" }], ["writer"]).map((item) => item.id)).toEqual([
      "writer",
    ]);
    expect(
      buildRoomFileRef(
        { projectId: "p1", fileId: "f1", kind: "output", version: "3" },
        "revise",
      ),
    ).toEqual({
      project_id: "p1",
      file_id: "f1",
      kind: "output",
      version: "3",
      purpose: "revise",
    });
  });

  it("提问在回答前持续读秒，回答后停在耗时", () => {
    const start = "2026-11-04T08:00:00";
    const human = {
      turn_id: "t1",
      author_type: "human",
      turn_state: "running",
      created_at: start,
    };
    const waiting = questionClock(human, [human], Date.parse("2026-11-04T08:00:12Z"));
    expect(waiting).toMatchObject({ pending: true, status: "生成中", elapsedMs: 12000 });
    expect(formatElapsedSeconds(waiting.elapsedMs ?? 0)).toBe("12s");
    const reply = {
      turn_id: "t1",
      author_type: "agent",
      turn_state: "succeeded",
      created_at: "2026-11-04T08:00:09",
    };
    const answered = questionClock(human, [human, reply], Date.parse("2026-11-04T08:10:00Z"));
    expect(answered).toMatchObject({ pending: false, status: "已回答", elapsedMs: 9000 });
    expect(formatElapsedSeconds(65_000)).toBe("1:05");
  });
});