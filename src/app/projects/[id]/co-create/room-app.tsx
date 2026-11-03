"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FilePreviewPanel } from "@/app/projects/[id]/co-create/components/FilePreviewPanel";
import { ProjectFilesPanel } from "@/app/projects/[id]/co-create/components/ProjectFilesPanel";
import { useFileWorkspace } from "@/app/projects/[id]/co-create/hooks/use-file-workspace";
import { apiGet, apiPost } from "@/lib/api";
import { encodeProjectFileSelectValue, decodeProjectFileSelectValue } from "@/lib/chat-context";
import {
  applyFileAction,
  fetchProjectFileDetail,
  renameProjectFile,
  type ProjectFileVersionItem,
} from "@/lib/co-create-api";

type RoleMeta = { id: string; name: string; description?: string };
type MemberRow = { user_id: string; role: string };
type RoomSummary = {
  id: string;
  title: string;
  role_ids: string[];
  writer_role_id: string;
  output_id: string | null;
  doc_version: number;
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

function mergeMessages(current: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
}

export default function CoCreateRoomApp() {
  const params = useParams();
  const projectId = String(params?.id || "");
  const [roles, setRoles] = useState<RoleMeta[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [fileSaving, setFileSaving] = useState(false);
  const [filesPinned, setFilesPinned] = useState(false);
  const [filesRevealed, setFilesRevealed] = useState(false);
  const filesHideTimer = useRef<number | null>(null);
  const filesOpen = filesPinned || filesRevealed;
  const fileWorkspace = useFileWorkspace(projectId);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [docVersion, setDocVersion] = useState(0);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [mentionFileIds, setMentionFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [writerRoleId, setWriterRoleId] = useState("");
  const [error, setError] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const seatedRoles = useMemo(() => {
    const ids = new Set(activeRoom?.role_ids ?? []);
    return roles.filter((role) => ids.has(role.id));
  }, [activeRoom, roles]);

  const loadRooms = useCallback(async () => {
    const data = await apiGet<{ items: RoomSummary[] }>(`/projects/${projectId}/rooms`);
    setRooms(data.items ?? []);
    console.info("[co-create-room] 房间列表", { projectId, count: data.items?.length ?? 0 });
    return data.items ?? [];
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
    void load<MemberRow[]>(`/projects/${projectId}/members`, (data) => setMembers(data ?? []));
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
    if (!outputId || docVersion <= 0) return;
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
        await applyFileAction(projectId, {
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
        console.info("[co-create-room] 手动编辑已保存", { projectId, fileKey });
      } finally {
        setFileSaving(false);
      }
    },
    [activeId, fileWorkspace, projectId],
  );

  const handleRenameFile = useCallback(
    async (fileKey: string, title: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) throw new Error("无法识别文件");
      const result = await renameProjectFile(projectId, decoded.id, decoded.kind, title);
      fileWorkspace.patchTabTitle(fileKey, result.title);
      await fileWorkspace.refreshFiles();
    },
    [fileWorkspace, projectId],
  );

  const handleRestoreVersion = useCallback(
    async (version: ProjectFileVersionItem) => {
      const fileKey = fileWorkspace.activeFileKey;
      if (!fileKey) throw new Error("请先打开要恢复的文件");
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded || decoded.kind !== "output") throw new Error("仅支持恢复输出类文件");
      const detail = await fetchProjectFileDetail(projectId, version.id, "output");
      setFileSaving(true);
      try {
        await applyFileAction(projectId, {
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
    [activeId, fileWorkspace, projectId],
  );

  const mentionItems = useMemo(() => {
    if (mentionQuery == null) return [];
    const q = mentionQuery.toLowerCase();
    const roleItems = seatedRoles
      .filter((role) => !q || role.name.toLowerCase().includes(q) || role.id.toLowerCase().includes(q))
      .map((role) => ({ kind: "role" as const, id: role.id, label: role.name }));
    const fileItems = fileWorkspace.files
      .filter((file) => !q || file.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map((file) => ({ kind: "file" as const, id: file.id, label: file.title }));
    return [...roleItems, ...fileItems];
  }, [mentionQuery, seatedRoles, fileWorkspace.files]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    const match = /@([^\s@]*)$/.exec(value);
    setMentionQuery(match ? match[1] : null);
  };

  const insertMention = (item: { kind: "role" | "file"; id: string; label: string }) => {
    const next = draft.replace(/@([^\s@]*)$/, `@${item.label} `);
    setDraft(next);
    setMentionQuery(null);
    if (item.kind === "file") {
      setMentionFileIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    }
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
      const message = await apiPost<RoomMessage>(
        `/projects/${projectId}/rooms/${roomId}/messages`,
        { content: text, mention_file_ids: mentionFileIds },
      );
      setMessages((prev) => mergeMessages(prev, [message]));
      setDraft("");
      setMentionFileIds([]);
      setMentionQuery(null);
      console.info("[co-create-room] 发送", { projectId, roomId, seq: message.seq });
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

  if (!projectId) {
    return <div className="p-8 text-sm text-slate-500">缺少项目 ID</div>;
  }

  const roomList = (
      <aside className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <Link href={`/projects/${projectId}`} className="shrink-0 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            ← 项目
          </Link>
          <h1 className="truncate text-sm font-semibold">共创对话</h1>
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
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              onClick={() => {
                setMessages([]);
                setOutputId(room.output_id);
                setDocVersion(room.doc_version ?? 0);
                openedDocRef.current = "";
                setActiveId(room.id);
              }}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                room.id === activeId
                  ? "bg-blue-500/15 text-blue-700 dark:text-blue-200"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              <span className="block truncate font-medium">{room.title}</span>
              <span className="text-[11px] text-slate-500">
                {room.doc_version > 0 ? `文档 v${room.doc_version}` : "待创建"}
              </span>
            </button>
          ))}
          {rooms.length === 0 ? <p className="px-2 py-4 text-xs text-slate-500">还没有共创对话</p> : null}
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
              <button
                type="button"
                disabled={creating}
                onClick={() => void createRoom("bot")}
                className="w-full rounded-full border border-blue-500/40 bg-blue-500/15 px-2 py-1 text-xs text-blue-700 transition hover:bg-blue-500/25 disabled:opacity-40 dark:text-blue-200"
              >
                新建Bot
              </button>
              <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto" role="group" aria-label="入座角色">
                {roles.map((role) => {
                  const selected = selectedRoles.includes(role.id);
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
                      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-2 py-0.5 text-center text-[10px] leading-4 transition ${
                        selected
                          ? "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-200"
                          : "border-slate-200 bg-slate-100 text-slate-600 hover:border-slate-300 hover:bg-slate-200 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200"
                      }`}
                    >
                      {role.name}
                    </button>
                  );
                })}
              </div>
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
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!activeRoom ? (
            <p className="pt-16 text-center text-sm text-slate-500">选择一场对话，或在左侧新建。</p>
          ) : messages.length === 0 ? (
            <p className="pt-16 text-center text-sm text-slate-500">
              成员可以直接发言。用 @ 叫入座角色一起讨论，主笔会把这轮收成右侧文档。
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
          {mentionQuery != null && mentionItems.length > 0 ? (
            <div className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {mentionItems.map((item) => (
                <button
                  key={`${item.kind}-${item.id}`}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertMention(item)}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <span>{item.label}</span>
                  <span className="text-[10px] text-slate-400">{item.kind === "role" ? "角色" : "文件"}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
            <textarea
              value={draft}
              aria-label="发言"
              disabled={sending}
              rows={2}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="直接输入，回车发送。还没有对话时会自动新建"
              className="max-h-32 min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm outline-none"
            />
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void send()}
              className="rounded-full bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
            >
              发送
            </button>
          </div>
          {members.length > 0 ? (
            <p className="mt-1 truncate text-[11px] text-slate-400">
              成员 {members.map((member) => member.user_id).join("、")}
            </p>
          ) : null}
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
            projectId={projectId}
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
          className={`h-full shrink-0 overflow-hidden border-l border-slate-300 transition-[width] duration-150 dark:border-slate-700 ${
            filesOpen ? "w-60" : "w-7"
          }`}
          onMouseEnter={revealFiles}
          onMouseLeave={concealFiles}
        >
          {filesOpen ? (
            <div className="flex h-full w-60 flex-col">
              <div className="flex shrink-0 justify-end border-b border-slate-300 bg-slate-100 px-2 py-0.5 dark:border-slate-700 dark:bg-slate-900/40">
                <button
                  type="button"
                  onClick={() => {
                    setFilesPinned((pinned) => {
                      const next = !pinned;
                      console.info("[co-create-room] 文件栏", { projectId, pinned: next });
                      return next;
                    });
                  }}
                  className="text-[10px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                >
                  {filesPinned ? "自动隐藏" : "固定"}
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ProjectFilesPanel
                  projectId={projectId}
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
                />
              </div>
            </div>
          ) : (
            <button
              type="button"
              aria-label="显示项目文件"
              onClick={() => setFilesPinned(true)}
              className="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:bg-slate-900/40 dark:hover:bg-slate-800"
            >
              <span className="text-[10px] tracking-widest [writing-mode:vertical-rl]">项目文件</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
