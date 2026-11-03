export type RoomFilePurpose = "material" | "target" | "interpret" | "revise";

export type RoomFileRef = {
  project_id: string;
  file_id: string;
  kind: "output" | "attachment";
  version?: string;
  purpose: RoomFilePurpose;
};

export function acceptRoomPayload(
  requestedRoomId: string,
  activeRoomId: string | null,
  epoch: number,
  currentEpoch: number,
): boolean {
  return requestedRoomId === activeRoomId && epoch === currentEpoch;
}

export function seatedRoles<T extends { id: string }>(roles: T[], seatedIds: readonly string[]): T[] {
  const seated = new Set(seatedIds);
  return roles.filter((role) => seated.has(role.id));
}

export function buildRoomFileRef(
  file: { projectId: string; fileId: string; kind: "output" | "attachment"; version?: string | null },
  purpose: RoomFilePurpose,
): RoomFileRef {
  return {
    project_id: file.projectId,
    file_id: file.fileId,
    kind: file.kind,
    version: file.version || undefined,
    purpose,
  };
}
