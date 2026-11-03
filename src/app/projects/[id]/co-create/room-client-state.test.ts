import { describe, expect, it } from "vitest";

import { acceptRoomPayload, buildRoomFileRef, seatedRoles } from "./room-client-state";

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
});