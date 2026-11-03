"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  coCreateAgentModeMeta,
  isPlanConfirmPrompt,
  type CoCreateAgentMode,
} from "@/app/projects/[id]/co-create/co-create-agent-utils";
import { FilePreviewPanel } from "@/app/projects/[id]/co-create/components/FilePreviewPanel";
import { ProjectFilesPanel } from "@/app/projects/[id]/co-create/components/ProjectFilesPanel";
import { useFileWorkspace } from "@/app/projects/[id]/co-create/hooks/use-file-workspace";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import {
  encodeProjectFileSelectValue,
  decodeProjectFileSelectValue,
  type ProjectRecord,
} from "@/lib/chat-context";
import {
  applyFileAction,
  fetchProjectFileDetail,
  renameProjectFile,
  type ProjectFileVersionItem,
} from "@/lib/co-create-api";

type RoleMeta = { id: string; name: string; description?: string };
type RoomSummary = {
  id: string;
  title: string;
  role_ids: string[];
  writer_role_id: string;
  output_id: string | null;
  doc_version: number;
  archived_at?: string | null;
  content?: string;
};
type RoomMessage = {
  id: string;
  seq: number;
  turn_id: string;
  author_type: "human" | "agent";
  author_id: string;
  author_name: string;
  content: string;
  turn_state: string;
};

const POLL_MS = 2000;
const ROOM_AGENT_MODES: CoCreateAgentMode[] = ["ask", "agent", "plan"];

function hashRoleId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function layoutRoleCloud(ids: string[]): Map<string, { x: number; y: number; duration: number; delay: number; dx: number; dy: number }> {
  const points = ids.map((id) => {
    const hash = hashRoleId(id);
    return {
      id,
      x: 14 + (hash % 62),
      y: 8 + ((hash >>> 8) % 76),
      duration: 6 + (hash % 5),
      delay: ((hash >>> 4) % 12) * 0.35,
      dx: (hash % 2 === 0 ? 1 : -1) * (3 + (hash % 4)),
      dy: ((hash >>> 2) % 2 === 0 ? 1 : -1) * (4 + ((hash >>> 6) % 5)),
    };
  });
  for (let pass = 0; pass < 10; pass += 1) {
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const a = points[i];
        const b = points[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist >= 22) continue;
        const push = (22 - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x = Math.min(78, Math.max(12, a.x + ux * push));
        a.y = Math.min(90, Math.max(8, a.y + uy * push));
        b.x = Math.min(78, Math.max(12, b.x - ux * push));
        b.y = Math.min(90, Math.max(8, b.y - uy * push));
      }
    }
  }
  return new Map(points.map((point) => [point.id, point]));
}

export type RoomMentionKind = "role" | "file";

/** 输入框末尾的触发符：@ 关联 Bot，# 引用文档。后出现的触发符生效。 */
export function readRoomComposerMention(
  value: string,
): { kind: RoomMentionKind; query: string } | null {
  const at = /@([^\s@#]*)$/.exec(value);
  const hash = /#([^\s@#]*)$/.exec(value);
  const atIndex = at?.index ?? -1;
  const hashIndex = hash?.index ?? -1;
  if (at && atIndex >= hashIndex) return { kind: "role", query: at[1] ?? "" };
  if (hash) return { kind: "file", query: hash[1] ?? "" };
  return null;
}

function mentionTokenPresent(text: string, trigger: "@" | "#", label: string): boolean {
  const name = label.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${trigger}${escaped}(?=\\s|$)`).test(text);
}

function mergeMessages(current: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
}

export default function CoCreateRoomApp() {
  const params = useParams();
  const projectId = String(params?.id || "");
  const [fileProjectId, setFileProjectId] = useState(projectId);
  const [bindableProjects, setBindableProjects] = useState<ProjectRecord[]>([]);
  const [roles, setRoles] = useState<RoleMeta[]>([]);
  const [fileSaving, setFileSaving] = useState(false);
  const [filesPinned, setFilesPinned] = useState(false);
  const [filesRevealed, setFilesRevealed] = useState(false);
  const filesHideTimer = useRef<number | null>(null);
  const filesOpen = filesPinned || filesRevealed;
  const fileWorkspace = useFileWorkspace(fileProjectId);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [agentMode, setAgentMode] = useState<CoCreateAgentMode>("agent");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [roomActingId, setRoomActingId] = useState<string | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [writerRoleId, setWriterRoleId] = useState("");
  const [error, setError] = useState("");
  const [mention, setMention] = useState<{ kind: RoomMentionKind; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const skipTitleBlurRef = useRef(false);

  const revealFiles = () => {
    if (filesHideTimer.current) window.clearTimeout(filesHideTimer.current);
    setFilesRevealed(true);
  };

  const concealFiles = () => {
    if (filesPinned) return;
    if (filesHideTimer.current) window.clearTimeout(filesHideTimer.current);
    filesHideTimer.current = window.setTimeout(() => {
      setFilesRevealed(false);
      console.info("[co-create-room] 文件栏自动隐藏", { projectId });
    }, 280);
  };

  useEffect(() => {
    return () => {
      if (filesHideTimer.current) window.clearTimeout(filesHideTimer.current);
    };
  }, []);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const activeRoom = rooms.find((room) => room.id === activeId) ?? null;

  const loadRooms = useCallback(async () => {
    const data = await apiGet<{ items: RoomSummary[] }>(`/projects/${projectId}/rooms`);
    setRooms(data.items ?? []);
    console.info("[co-create-room] 房间列表", { projectId, count: data.items?.length ?? 0 });
    return data.items ?? [];
  }, [projectId]);

  useEffect(() => {
    setFileProjectId(projectId);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    apiGet<ProjectRecord[]>("/projects/")
      .then((rows) => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setBindableProjects(list);
        console.info("[co-create-room] 可绑定项目", {
          projectId,
          active: list.filter((item) => item.status === "active").length,
        });
      })
      .catch((err) => {
        console.warn("[co-create-room] 项目列表加载失败", err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = async <T,>(path: string, apply: (data: T) => void) => {
      try {
        const data = await apiGet<T>(path);
        if (!cancelled) apply(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      }
    };
    void load<{ items: RoleMeta[] }>("/brainstorm/roles", (data) => setRoles(data.items ?? []));
    loadRooms().catch((err: Error) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, loadRooms]);

  const refreshRoom = useCallback(
    async (roomId: string) => {
      const data = await apiGet<RoomSummary & { messages: RoomMessage[] }>(
        `/projects/${projectId}/rooms/${roomId}/messages?after=0`,
      );
      if (activeIdRef.current !== roomId) return data;
      setMessages((prev) => mergeMessages(prev, data.messages ?? []));
      setDocVersion(data.doc_version ?? 0);
      setOutputId(data.output_id ?? null);
      setRooms((prev) =>
        prev.map((room) =>
          room.id === roomId
            ? {
                ...room,
                output_id: data.output_id,
                doc_version: data.doc_version,
                content: data.content,
              }
            : room,
        ),
      );
      return data;
    },
    [projectId],
  );

  useEffect(() => {
    if (!projectId || !activeId) return;
    let cancelled = false;
    refreshRoom(activeId)
      .then((data) => {
        if (cancelled) return;
        console.info("[co-create-room] 打开对话", {
          projectId,
          roomId: activeId,
          docVersion: data.doc_version,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    const timer = window.setInterval(() => {
      refreshRoom(activeId).catch((err: Error) => {
        console.warn("[co-create-room] 轮询失败", { projectId, roomId: activeId, err });
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, activeId, refreshRoom]);

  useEffect(() => {
    const node = listRef.current;
    if (node && typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [messages.length, activeId]);

  useEffect(() => {
    if (!activeId || docVersion <= 0) return;
    console.info("[co-create-room] 文档版本", { projectId, roomId: activeId, docVersion });
  }, [activeId, docVersion, projectId]);

  const openedDocRef = useRef("");
  useEffect(() => {
    if (!outputId || docVersion <= 0 || fileProjectId !== projectId) return;
    const fileKey = encodeProjectFileSelectValue("output", outputId);
    const token = `${activeId}:${fileKey}:${docVersion}`;
    if (openedDocRef.current === token) return;
    openedDocRef.current = token;
    fileWorkspace.openFileTab(fileKey);
    void fileWorkspace.reloadFileTab(fileKey);
    void fileWorkspace.refreshFiles();
    console.info("[co-create-room] 打开结果文档", { projectId, roomId: activeId, fileKey, docVersion });
  }, [
    activeId,
    docVersion,
    fileWorkspace.openFileTab,
    fileWorkspace.refreshFiles,
    fileProjectId,
    fileWorkspace.reloadFileTab,
    outputId,
    projectId,
  ]);

  const handleSaveFileContent = useCallback(
    async (fileKey: string, content: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded || decoded.kind !== "output") throw new Error("仅支持编辑输出类文件");
      setFileSaving(true);
      try {
        await applyFileAction(fileProjectId, {
          session_id: activeId ?? undefined,
          proposal_id: crypto.randomUUID(),
          action: {
            type: "patch",
            target_file_id: decoded.id,
            target_kind: decoded.kind,
            content,
            file_name: fileWorkspace.tabLabels[fileKey],
            save_mode: "overwrite",
          },
        });
        fileWorkspace.patchTabContent(fileKey, content);
        await fileWorkspace.refreshFiles();
        await fileWorkspace.reloadFileTab(fileKey);
        console.info("[co-create-room] 手动编辑已保存", { projectId: fileProjectId, fileKey });
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, fileProjectId, fileWorkspace],
  );

  const handleRenameFile = useCallback(
    async (fileKey: string, title: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) throw new Error("无法识别文件");
      const result = await renameProjectFile(fileProjectId, decoded.id, decoded.kind, title);
      fileWorkspace.patchTabTitle(fileKey, result.title);
      await fileWorkspace.refreshFiles();
    },
    [fileProjectId, fileWorkspace],
  );

  const handleRestoreVersion = useCallback(
    async (version: ProjectFileVersionItem) => {
      const fileKey = fileWorkspace.activeFileKey;
      if (!fileKey) throw new Error("请先打开要恢复的文件");
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded || decoded.kind !== "output") throw new Error("仅支持恢复输出类文件");
      const detail = await fetchProjectFileDetail(fileProjectId, version.id, "output");
      setFileSaving(true);
      try {
        await applyFileAction(fileProjectId, {
          session_id: activeId ?? undefined,
          proposal_id: crypto.randomUUID(),
          action: {
            type: "patch",
            target_file_id: decoded.id,
            target_kind: "output",
            content: detail.content ?? "",
            file_name: version.title ?? fileWorkspace.tabLabels[fileKey],
            save_mode: "overwrite",
          },
        });
        await fileWorkspace.reloadFileTab(fileKey);
        await fileWorkspace.refreshFiles();
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, fileProjectId, fileWorkspace],
  );

  const mentionItems = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    if (mention.kind === "role") {
      const seated = new Set(activeRoom?.role_ids ?? []);
      return roles
        .filter((role) => !q || role.name.toLowerCase().includes(q) || role.id.toLowerCase().includes(q))
        .sort((a, b) => Number(seated.has(b.id)) - Number(seated.has(a.id)))
        .map((role) => ({ kind: "role" as const, id: role.id, label: role.name }));
    }
    return fileWorkspace.files
      .filter(
        (file) =>
          !q ||
          file.title.toLowerCase().includes(q) ||
          file.path.toLowerCase().includes(q),
      )
      .slice(0, 8)
      .map((file) => ({ kind: "file" as const, id: file.id, label: file.title }));
  }, [activeRoom?.role_ids, fileWorkspace.files, mention, roles]);

  const roleCloud = useMemo(() => layoutRoleCloud(roles.map((role) => role.id)), [roles]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.kind, mention?.query]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    setMention(readRoomComposerMention(value));
  };

  const insertMention = (item: { kind: RoomMentionKind; id: string; label: string }) => {
    const trigger = item.kind === "role" ? "@" : "#";
    const next = draft.replace(/[@#]([^\s@#]*)$/, `${trigger}${item.label} `);
    setDraft(next);
    setMention(null);
    console.info("[co-create-room] 插入引用", {
      projectId,
      kind: item.kind === "role" ? "bot" : "file",
      id: item.id,
      label: item.label,
    });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      let roomId = activeId;
      if (!roomId) {
        roomId = await createRoom("chat", text.slice(0, 24));
        if (!roomId) return;
      }
      const mentionRoleIds = roles
        .filter((role) => mentionTokenPresent(text, "@", role.name))
        .map((role) => role.id);
      const mentionFileIds = fileWorkspace.files
        .filter((file) => mentionTokenPresent(text, "#", file.title))
        .map((file) => file.id);
      const modeToSend: CoCreateAgentMode =
        agentMode === "plan" && isPlanConfirmPrompt(text) ? "agent" : agentMode;
      if (modeToSend !== agentMode) {
        setAgentMode("agent");
        console.info("[co-create-room] 计划已确认，切换 Agent 执行", { projectId, roomId });
      }
      const message = await apiPost<RoomMessage>(
        `/projects/${projectId}/rooms/${roomId}/messages`,
        {
          content: text,
          mention_role_ids: mentionRoleIds,
          mention_file_ids: mentionFileIds,
          agent_mode: modeToSend,
        },
      );
      setMessages((prev) => mergeMessages(prev, [message]));
      setDraft("");
      setMention(null);
      console.info("[co-create-room] 发送", { projectId, roomId, seq: message.seq, agentMode: modeToSend });
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  const createRoom = async (kind: "chat" | "bot", title?: string): Promise<string | null> => {
    if (creating) return null;
    setCreating(true);
    setError("");
    const roleIds = kind === "bot" ? selectedRoles : [];
    const writerId = kind === "bot" ? writerRoleId || selectedRoles[0] || "" : "";
    try {
      const room = await apiPost<RoomSummary>(`/projects/${projectId}/rooms`, {
        title: title?.trim() || (kind === "bot" ? "新 Bot" : "共创对话"),
        role_ids: roleIds,
        writer_role_id: writerId,
      });
      console.info("[co-create-room] 创建对话", { projectId, roomId: room.id, kind });
      await loadRooms();
      setMessages([]);
      setOutputId(null);
      setDocVersion(0);
      openedDocRef.current = "";
      setActiveId(room.id);
      return room.id;
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
      return null;
    } finally {
      setCreating(false);
    }
  };

  const openRoom = (room: RoomSummary) => {
    setMessages([]);
    setOutputId(room.output_id);
    setDocVersion(room.doc_version ?? 0);
    openedDocRef.current = "";
    setActiveId(room.id);
  };

  const saveRoomTitle = async (roomId: string) => {
    const title = titleDraft.trim();
    if (!title) {
      setError("名称不能为空");
      return;
    }
    const current = rooms.find((room) => room.id === roomId);
    if (current?.title === title) {
      setEditingRoomId(null);
      return;
    }
    setRoomActingId(roomId);
    setError("");
    try {
      const updated = await apiPatch<RoomSummary>(`/projects/${projectId}/rooms/${roomId}`, { title });
      setRooms((prev) => prev.map((room) => (room.id === roomId ? { ...room, ...updated } : room)));
      setEditingRoomId(null);
      console.info("[co-create-room] 对话改名", { projectId, roomId, title: updated.title });
    } catch (err) {
      setError(err instanceof Error ? err.message : "改名失败");
    } finally {
      setRoomActingId(null);
    }
  };

  const setRoomArchived = async (room: RoomSummary, archived: boolean) => {
    setRoomActingId(room.id);
    setError("");
    try {
      const updated = await apiPatch<RoomSummary>(`/projects/${projectId}/rooms/${room.id}`, { archived });
      setRooms((prev) => prev.map((item) => (item.id === room.id ? { ...item, ...updated } : item)));
      if (archived && activeId === room.id) {
        setActiveId(null);
        setMessages([]);
        setOutputId(null);
        setDocVersion(0);
        openedDocRef.current = "";
      }
      console.info("[co-create-room] 对话归档", {
        projectId,
        roomId: room.id,
        archived,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : archived ? "归档失败" : "恢复失败");
    } finally {
      setRoomActingId(null);
    }
  };

  if (!projectId) {
    return <div className="p-8 text-sm text-slate-500">缺少项目 ID</div>;
  }

  const roomList = (
      <aside className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex h-[41px] shrink-0 items-center justify-between gap-2 border-b border-slate-300 px-3 dark:border-slate-700">
          <Link href={`/projects/${projectId}`} className="shrink-0 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            ← 项目
          </Link>
          <h1 className="truncate text-xs font-semibold">共创对话</h1>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          <button
            type="button"
            disabled={creating}
            onClick={() => void createRoom("chat")}
            className="mb-1 w-full rounded-lg bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
          >
            新建对话
          </button>
          {rooms.filter((room) => !room.archived_at).map((room) => {
            const selected = room.id === activeId;
            const editing = editingRoomId === room.id;
            return (
              <div
                key={room.id}
                className={`rounded-lg px-2 py-1.5 text-sm ${
                  selected
                    ? "bg-blue-500/15 text-blue-700 dark:text-blue-200"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                {editing ? (
                  <input
                    aria-label="对话名称"
                    value={titleDraft}
                    disabled={roomActingId === room.id}
                    autoFocus
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveRoomTitle(room.id);
                      }
                      if (event.key === "Escape") {
                        skipTitleBlurRef.current = true;
                        setEditingRoomId(null);
                      }
                    }}
                    onBlur={() => {
                      if (skipTitleBlurRef.current) {
                        skipTitleBlurRef.current = false;
                        return;
                      }
                      void saveRoomTitle(room.id);
                    }}
                    className="w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-sm text-slate-900 outline-none dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  />
                ) : (
                  <button type="button" onClick={() => openRoom(room)} className="block w-full truncate px-1 text-left font-medium">
                    {room.title}
                  </button>
                )}
                <div className="mt-0.5 flex items-center justify-between gap-1 px-1">
                  <span className="truncate text-[11px] text-slate-500">
                    {room.doc_version > 0 ? `文档 v${room.doc_version}` : ""}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={roomActingId === room.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setEditingRoomId(room.id);
                        setTitleDraft(room.title);
                      }}
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    >
                      改名
                    </button>
                    <button
                      type="button"
                      disabled={roomActingId === room.id}
                      onMouseDown={() => {
                        skipTitleBlurRef.current = true;
                      }}
                      onClick={() => void setRoomArchived(room, true)}
                      className="rounded px-1 text-[10px] text-slate-500 hover:bg-white hover:text-slate-800 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    >
                      归档
                    </button>
                  </span>
                </div>
              </div>
            );
          })}
          {rooms.some((room) => !room.archived_at) ? null : (
            <p className="px-2 py-4 text-xs text-slate-500">还没有共创对话</p>
          )}
          {rooms.some((room) => room.archived_at) ? (
            <button
              type="button"
              onClick={() => setShowArchived((prev) => !prev)}
              className="w-full px-2 py-1 text-left text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            >
              {showArchived ? "收起" : "已归档"} {rooms.filter((room) => room.archived_at).length}
            </button>
          ) : null}
          {showArchived
            ? rooms
                .filter((room) => room.archived_at)
                .map((room) => (
                  <div key={room.id} className="rounded-lg px-2 py-1.5 text-sm text-slate-500">
                    <span className="block truncate px-1">{room.title}</span>
                    <div className="mt-0.5 flex justify-end px-1">
                      <button
                        type="button"
                        disabled={roomActingId === room.id}
                        onClick={() => void setRoomArchived(room, false)}
                        className="rounded px-1 text-[10px] hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                      >
                        恢复
                      </button>
                    </div>
                  </div>
                ))
            : null}
        </div>
        <div className="flex h-[31rem] shrink-0 flex-col gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
          {roles.length === 0 ? (
            <p className="text-xs leading-relaxed text-slate-500">
              可以先建对话。角色稍后在配置
              <Link href="/settings?tab=roles" className="mx-1 text-blue-600 hover:underline">
                Roles
              </Link>
              里添加，再点选入座。
            </p>
          ) : null}
              <div className="relative min-h-0 flex-1 overflow-hidden" role="group" aria-label="入座角色">
                <style>{`
                  @keyframes co-create-role-drift {
                    0%, 100% { transform: translate(-50%, -50%) translate(0, 0); }
                    50% { transform: translate(-50%, -50%) translate(var(--drift-x), var(--drift-y)); }
                  }
                  @media (prefers-reduced-motion: reduce) {
                    .co-create-role-point { animation: none !important; }
                  }
                `}</style>
                {roles.map((role) => {
                  const selected = selectedRoles.includes(role.id);
                  const point = roleCloud.get(role.id);
                  return (
                    <button
                      key={role.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedRoles((prev) => {
                          const next = prev.includes(role.id)
                            ? prev.filter((id) => id !== role.id)
                            : [...prev, role.id];
                          if (!next.includes(writerRoleId)) setWriterRoleId(next[0] ?? "");
                          else if (!writerRoleId && next[0]) setWriterRoleId(next[0]);
                          return next;
                        });
                      }}
                      className={`co-create-role-point absolute inline-flex items-center justify-center whitespace-nowrap rounded-full border px-2 py-0.5 text-center text-[10px] leading-4 hover:z-10 hover:[animation-play-state:paused] ${
                        selected
                          ? "z-[2] border-blue-500/40 bg-blue-500/15 text-blue-700 shadow-[0_0_12px_rgba(59,130,246,0.35)] dark:text-blue-200"
                          : "border-slate-200/80 bg-white/80 text-slate-600 hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300"
                      }`}
                      style={{
                        left: `${point?.x ?? 50}%`,
                        top: `${point?.y ?? 50}%`,
                        animation: `co-create-role-drift ${point?.duration ?? 7}s ease-in-out ${point?.delay ?? 0}s infinite`,
                        ["--drift-x" as string]: `${point?.dx ?? 4}px`,
                        ["--drift-y" as string]: `${point?.dy ?? 6}px`,
                      }}
                    >
                      {role.name}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                disabled={creating}
                onClick={() => void createRoom("bot")}
                className="w-full shrink-0 rounded-full border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-xs text-blue-700 transition hover:bg-blue-500/25 disabled:opacity-40 dark:text-blue-200"
              >
                新建Bot
              </button>
              {selectedRoles.length > 0 ? (
                <div className="flex flex-wrap gap-1" role="group" aria-label="主笔">
                  {roles
                    .filter((role) => selectedRoles.includes(role.id))
                    .map((role) => {
                      const selected = writerRoleId === role.id;
                      return (
                        <button
                          key={role.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setWriterRoleId(role.id)}
                          className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-center text-[10px] leading-4 transition ${
                            selected
                              ? "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-200"
                              : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400"
                          }`}
                        >
                          主笔 · {role.name}
                        </button>
                      );
                    })}
                </div>
              ) : null}
        </div>
      </aside>
  );

  const conversation = (
      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <div className="flex h-[41px] shrink-0 items-center border-b border-slate-300 px-3 dark:border-slate-700">
          <p className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
            {activeRoom?.title || "共创对话"}
          </p>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!activeRoom ? (
            <p className="pt-16 text-center text-sm text-slate-500">与你的团队成员+AIbot进行共创项目</p>
          ) : messages.length === 0 ? (
            <p className="pt-16 text-center text-sm text-slate-500">
              成员可以直接发言。用 @ 叫 Bot，用 # 引用文档。
            </p>
          ) : (
            messages.map((message) => (
              <article key={message.id} className="max-w-3xl">
                <p className="text-[11px] text-slate-500">
                  {message.author_type === "agent" ? "Agent" : "成员"} · {message.author_name}
                  {message.turn_state === "queued" ? " · 排队" : ""}
                </p>
                <div
                  className={`mt-1 rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    message.author_type === "agent"
                      ? "bg-white dark:bg-slate-900"
                      : "bg-blue-500/10"
                  }`}
                >
                  {message.content}
                </div>
              </article>
            ))
          )}
        </div>
        {error ? <p className="px-4 text-xs text-red-600">{error}</p> : null}
        <div className="relative border-t border-slate-200 p-3 dark:border-slate-800">
          {mention && mentionItems.length > 0 ? (
            <div
              role="listbox"
              aria-label={mention.kind === "role" ? "选择 Bot" : "选择文档"}
              className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
            >
              {mentionItems.map((item, index) => (
                <button
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => insertMention(item)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                    index === mentionIndex
                      ? "bg-blue-50 text-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  <span>{item.label}</span>
                  <span className="text-[10px] text-slate-400">{item.kind === "role" ? "Bot" : "文档"}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <textarea
              value={draft}
              aria-label="发言"
              disabled={sending}
              rows={2}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (mention && mentionItems.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((prev) => (prev + 1) % mentionItems.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex((prev) => (prev - 1 + mentionItems.length) % mentionItems.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const picked = mentionItems[mentionIndex] ?? mentionItems[0];
                    if (picked) insertMention(picked);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="直接输入，回车发送。@ 关联 Bot，# 引用文档"
              className="max-h-32 min-h-[2.5rem] w-full flex-1 resize-none bg-transparent text-sm outline-none"
            />
            <div
              className="inline-flex self-start rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/80"
              role="group"
              aria-label="创作模式"
            >
              {ROOM_AGENT_MODES.map((mode) => {
                const meta = coCreateAgentModeMeta(mode);
                const active = agentMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={sending}
                    title={meta.description}
                    onClick={() => {
                      setAgentMode(mode);
                      console.info("[co-create-room] 对话模式切换", {
                        projectId,
                        roomId: activeId,
                        mode,
                      });
                    }}
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50 ${
                      active
                        ? `${meta.badgeClassName} border`
                        : "border border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                    }`}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </div>
            </div>
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
              className="rounded-full bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
            >
              发送
            </button>
          </div>
        </div>
      </section>
  );

  return (
    <div className="flex h-full min-h-0 bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="w-56 shrink-0">{roomList}</div>
      <div className="min-w-0 flex-1">{conversation}</div>
      <div className="flex min-h-0 w-[46%] min-w-[22rem] shrink-0">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden border-l border-slate-300 dark:border-slate-700">
          <FilePreviewPanel
            projectId={fileProjectId}
            openTabKeys={fileWorkspace.openTabKeys}
            activeFileKey={fileWorkspace.activeFileKey}
            tabLabels={fileWorkspace.tabLabels}
            previewDetail={fileWorkspace.previewDetail}
            previewLoading={fileWorkspace.previewLoading}
            versions={fileWorkspace.versions}
            saving={fileSaving}
            onSelectTab={fileWorkspace.selectFileTab}
            onCloseTab={fileWorkspace.closeFileTab}
            onReloadTab={(key) => void fileWorkspace.reloadFileTab(key)}
            onAddToRound={(key) => fileWorkspace.openFileTab(key)}
            onPin={(key) => fileWorkspace.openFileTab(key)}
            onSaveContent={handleSaveFileContent}
            onRenameFile={handleRenameFile}
            onRestoreVersion={handleRestoreVersion}
            onAskInterpret={(key) => {
              fileWorkspace.openFileTab(key);
              setDraft("请解读当前打开的文件，给出要点摘要。");
            }}
            onAskModify={(key) => {
              fileWorkspace.openFileTab(key);
              setDraft("请基于当前打开的文件修订右侧文档。");
            }}
          />
        </div>
        <div
          className={`h-full shrink-0 overflow-hidden border-l transition-[width] duration-150 ${
            filesOpen ? "w-60 border-slate-300 dark:border-slate-700" : "w-7 border-blue-500/40"
          }`}
          onMouseEnter={revealFiles}
          onMouseLeave={concealFiles}
        >
          {filesOpen ? (
            <div className="h-full w-60">
                <ProjectFilesPanel
                  projectId={fileProjectId}
                  boundProjectId={fileProjectId}
                  routeProjectId={projectId}
                  projects={bindableProjects}
                  onBoundProjectChange={(next) => {
                    setFileProjectId(next);
                    console.info("[co-create-room] 文件栏绑定项目", {
                      roomProjectId: projectId,
                      fileProjectId: next,
                    });
                  }}
                  files={fileWorkspace.files}
                  loading={fileWorkspace.loading}
                  openTabKeys={fileWorkspace.openTabKeys}
                  activeFileKey={fileWorkspace.activeFileKey}
                  pinnedFileIds={[]}
                  roundFileIds={[]}
                  onSelectPreview={(key) => {
                    if (key) fileWorkspace.openFileTab(key);
                  }}
                  onRefresh={() => void fileWorkspace.refreshFiles()}
                  pinLabel={filesPinned ? "自动隐藏" : "固定"}
                  onTogglePin={() => {
                    setFilesPinned((pinned) => {
                      const next = !pinned;
                      console.info("[co-create-room] 文件栏", { projectId, pinned: next });
                      return next;
                    });
                  }}
                />
            </div>
          ) : (
            <button
              type="button"
              aria-label="显示项目文件"
              onClick={() => setFilesPinned(true)}
              className="flex h-full w-full items-center justify-center bg-blue-500/15 text-blue-700 transition hover:bg-blue-500/25 dark:text-blue-200"
            >
              <span className="text-[10px] tracking-widest [writing-mode:vertical-rl]">项目文件</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
