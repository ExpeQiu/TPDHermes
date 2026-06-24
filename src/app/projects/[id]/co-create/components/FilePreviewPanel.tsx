"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { InlineTextDiff } from "@/app/projects/[id]/co-create/components/InlineTextDiff";
import type { SelectionToChatPayload } from "@/app/projects/[id]/co-create/co-create-types";
import type { ProjectFileDetail, ProjectFileVersionItem } from "@/lib/co-create-api";

type ViewTab = "preview" | "edit" | "versions";

type SelectionMenuState = SelectionToChatPayload & {
  x: number;
  y: number;
};

type Props = {
  openTabKeys: string[];
  activeFileKey: string | null;
  tabLabels: Record<string, string>;
  previewDetail: ProjectFileDetail | null;
  previewLoading: boolean;
  versions: ProjectFileVersionItem[];
  saving?: boolean;
  onSelectTab: (fileKey: string) => void;
  onCloseTab: (fileKey: string) => void;
  onAddToRound: (fileKey: string) => void;
  onPin: (fileKey: string) => void;
  onAskInterpret: (fileKey: string) => void;
  onAskModify: (fileKey: string) => void;
  onSaveContent?: (fileKey: string, content: string) => Promise<void>;
  onAddSelectionToChat?: (payload: SelectionToChatPayload) => void;
  onEditSelection?: (text: string) => void;
  onRewriteSelection?: (payload: SelectionToChatPayload) => void;
  /** 待确认的 AI 改写提案，预览区以 diff 高亮展示 */
  pendingPatch?: { before: string; after: string; summary?: string } | null;
};

function getSelectionMeta(container: HTMLElement | null): SelectionToChatPayload | null {
  if (!container) return null;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().trim();
  if (!text) return null;

  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = preRange.toString().length;
  const endOffset = startOffset + range.toString().length;
  const content = container.textContent ?? "";
  const startLine = content.slice(0, startOffset).split("\n").length;
  const endLine = content.slice(0, endOffset).split("\n").length;
  return { text, startLine, endLine };
}

function getSelectionInContainer(container: HTMLElement | null): string {
  return getSelectionMeta(container)?.text ?? "";
}

function selectionMenuPosition(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = container.getBoundingClientRect();
  const menuW = 220;
  const menuH = 88;
  const x = Math.min(Math.max(clientX - rect.left, 8), rect.width - menuW - 8);
  const y = Math.min(Math.max(clientY - rect.top, 8), rect.height - menuH - 8);
  return { x, y };
}

export function FilePreviewPanel({
  openTabKeys,
  activeFileKey,
  tabLabels,
  previewDetail,
  previewLoading,
  versions,
  saving,
  onSelectTab,
  onCloseTab,
  onAddToRound,
  onPin,
  onAskInterpret,
  onAskModify,
  onSaveContent,
  onAddSelectionToChat,
  onEditSelection,
  onRewriteSelection,
  pendingPatch,
}: Props) {
  const [viewTab, setViewTab] = useState<ViewTab>("preview");
  const [editDraft, setEditDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const autoSaveTimerRef = useRef<number | null>(null);

  const savedContent = previewDetail?.content ?? "";
  const canEdit = previewDetail?.kind === "output";
  const isDirty = editDraft !== savedContent;
  const showPatchDiff = Boolean(pendingPatch && viewTab === "preview");
  const diffBefore = pendingPatch?.before ?? savedContent;
  const diffAfter = pendingPatch?.after ?? savedContent;

  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);

  const openSelectionMenu = useCallback(
    (payload: SelectionToChatPayload, clientX: number, clientY: number) => {
      const container = previewRef.current;
      if (!container) return;
      const { x, y } = selectionMenuPosition(container, clientX, clientY);
      setSelectionMenu({ ...payload, x, y });
    },
    [],
  );

  useEffect(() => {
    setViewTab("preview");
    setSaveError(null);
    closeSelectionMenu();
  }, [activeFileKey, closeSelectionMenu]);

  useEffect(() => {
    setEditDraft(savedContent);
    setSaveError(null);
  }, [activeFileKey, savedContent]);

  useEffect(() => {
    if (viewTab !== "preview") closeSelectionMenu();
  }, [viewTab, closeSelectionMenu]);

  useEffect(() => {
    if (!selectionMenu) return;
    const dismiss = () => closeSelectionMenu();
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectionMenu, closeSelectionMenu]);

  useEffect(() => {
    if (viewTab !== "preview") return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const text = getSelectionInContainer(previewRef.current);
      if ((e.key === "i" || e.key === "I") && text) {
        e.preventDefault();
        setViewTab("edit");
        onEditSelection?.(text);
        closeSelectionMenu();
      }
      if ((e.key === "u" || e.key === "U") && text) {
        e.preventDefault();
        const meta = getSelectionMeta(previewRef.current);
        if (meta) onAddSelectionToChat?.(meta);
        closeSelectionMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewTab, onAddSelectionToChat, onEditSelection, closeSelectionMenu]);

  const handlePreviewMouseUp = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const meta = getSelectionMeta(previewRef.current);
    if (!meta) {
      closeSelectionMenu();
      return;
    }
    openSelectionMenu(meta, e.clientX, e.clientY);
  };

  const handlePreviewContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const meta = getSelectionMeta(previewRef.current);
    if (!meta) {
      closeSelectionMenu();
      return;
    }
    openSelectionMenu(meta, e.clientX, e.clientY);
  };

  const handleCopySelection = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 忽略剪贴板失败
    }
    closeSelectionMenu();
  };

  const handleEditSelection = (text: string) => {
    setViewTab("edit");
    onEditSelection?.(text);
    closeSelectionMenu();
  };

  const handleAddSelectionToChat = () => {
    if (!selectionMenu) return;
    onAddSelectionToChat?.({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    });
    closeSelectionMenu();
  };

  const handleAskRewriteSelection = () => {
    if (!selectionMenu) return;
    onRewriteSelection?.({
      text: selectionMenu.text,
      startLine: selectionMenu.startLine,
      endLine: selectionMenu.endLine,
    });
    closeSelectionMenu();
  };

  const handleSave = useCallback(async () => {
    if (!activeFileKey || !onSaveContent || !isDirty) return;
    setSaveError(null);
    try {
      await onSaveContent(activeFileKey, editDraft);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "保存失败");
    }
  }, [activeFileKey, editDraft, isDirty, onSaveContent]);

  const handleEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (canEdit && isDirty && !saving) void handleSave();
    }
  };

  useEffect(() => {
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (
      viewTab !== "edit" ||
      !activeFileKey ||
      !onSaveContent ||
      !canEdit ||
      !isDirty ||
      saving
    ) {
      return;
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      void handleSave();
    }, 900);
    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [activeFileKey, canEdit, handleSave, isDirty, onSaveContent, saving, viewTab]);

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-l border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="shrink-0 space-y-2 border-b border-slate-300 p-3 dark:border-slate-700">
        <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">文件预览</p>
        {openTabKeys.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {openTabKeys.map((fileKey) => {
              const active = fileKey === activeFileKey;
              const label = tabLabels[fileKey] ?? "未命名";
              return (
                <div
                  key={fileKey}
                  className={`group flex max-w-full items-center rounded-md text-[10px] ${
                    active
                      ? "bg-blue-600 text-white"
                      : "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                  }`}
                >
                  <button
                    type="button"
                    title={label}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        onCloseTab(fileKey);
                      }
                    }}
                    onClick={() => onSelectTab(fileKey)}
                    className="min-w-0 max-w-[8rem] truncate px-2 py-0.5 text-left"
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭 ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(fileKey);
                    }}
                    className={`mr-0.5 rounded px-1 py-0.5 transition ${
                      active
                        ? "hover:bg-blue-500"
                        : "opacity-60 hover:opacity-100 dark:hover:bg-slate-600"
                    }`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {activeFileKey ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-300 p-2 dark:border-slate-700">
            <ActionBtn label="加入本轮" onClick={() => onAddToRound(activeFileKey)} />
            <ActionBtn label="固定引用" onClick={() => onPin(activeFileKey)} />
            <ActionBtn label="AI 解读" onClick={() => onAskInterpret(activeFileKey)} />
            <ActionBtn label="AI 修改" onClick={() => onAskModify(activeFileKey)} />
            <div className="ml-auto flex items-center gap-1">
              <ViewTabBtn
                active={viewTab === "preview"}
                label="预览"
                onClick={() => setViewTab("preview")}
              >
                <EyeIcon />
              </ViewTabBtn>
              <ViewTabBtn
                active={viewTab === "edit"}
                label="编辑"
                onClick={() => setViewTab("edit")}
              >
                <PencilIcon />
              </ViewTabBtn>
              <ViewTabBtn
                active={viewTab === "versions"}
                label="版本"
                onClick={() => setViewTab("versions")}
              >
                <HistoryIcon />
              </ViewTabBtn>
              {viewTab === "edit" && isDirty ? (
                <span className="text-[10px] text-amber-600 dark:text-amber-400">未保存</span>
              ) : null}
            </div>
          </div>

          {viewTab === "edit" ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-slate-900/95">
              <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
                <button
                  type="button"
                  disabled={!canEdit || !isDirty || saving || !onSaveContent}
                  onClick={() => void handleSave()}
                  className="rounded-md bg-blue-600 px-2.5 py-0.5 text-[10px] text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "保存中…" : "保存"}
                </button>
                <button
                  type="button"
                  disabled={!isDirty || saving}
                  onClick={() => {
                    setEditDraft(savedContent);
                    setSaveError(null);
                  }}
                  className="rounded-md border border-slate-300 px-2.5 py-0.5 text-[10px] text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  撤销
                </button>
                <span className="text-[10px] text-slate-400">
                  {canEdit ? "默认自动保存，可随时按 ⌘S / Ctrl+S 主动保存" : "附件暂不支持直接保存"}
                </span>
              </div>
              {saveError ? (
                <p className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1 text-[10px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                  {saveError}
                </p>
              ) : null}
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={handleEditKeyDown}
                readOnly={!canEdit}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-slate-800 focus:outline-none focus:ring-0 dark:text-slate-200"
                spellCheck={false}
              />
            </div>
          ) : (
            <div
              ref={previewRef}
              className="relative min-h-0 flex-1 overflow-y-auto bg-white p-3 text-xs leading-relaxed dark:bg-slate-900/95"
              onMouseUp={viewTab === "preview" ? handlePreviewMouseUp : undefined}
              onContextMenu={viewTab === "preview" ? handlePreviewContextMenu : undefined}
            >
              {previewLoading ? (
                <p className="text-slate-500">加载预览…</p>
              ) : viewTab === "versions" ? (
                versions.length === 0 ? (
                  <p className="text-slate-500">暂无版本历史</p>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v) => (
                      <li key={v.id} className="rounded border border-slate-200 p-2 dark:border-slate-700">
                        <p className="font-medium">
                          v{v.version} · {v.title ?? "未命名"}
                        </p>
                        <p className="text-[10px] text-slate-500">{v.updated_at ?? v.created_at}</p>
                      </li>
                    ))}
                  </ul>
                )
              ) : showPatchDiff ? (
                <>
                  <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
                    AI 修改预览
                    {pendingPatch?.summary ? ` · ${pendingPatch.summary}` : ""}
                  </div>
                  <InlineTextDiff before={diffBefore} after={diffAfter} showLegend />
                </>
              ) : (
                <pre className="select-text whitespace-pre-wrap break-words font-sans text-slate-800 dark:text-slate-200">
                  {savedContent.slice(0, 8000) || "（无正文）"}
                </pre>
              )}

              {selectionMenu && viewTab === "preview" ? (
                <SelectionMenu
                  x={selectionMenu.x}
                  y={selectionMenu.y}
                  onEdit={() => handleEditSelection(selectionMenu.text)}
                  onAddToChat={handleAddSelectionToChat}
                  onRewrite={handleAskRewriteSelection}
                  onCopy={() => void handleCopySelection(selectionMenu.text)}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : null}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-xs leading-relaxed text-slate-500">
            从右侧文件列表打开文件，可同时预览多个 Tab
          </p>
        </div>
      )}
    </aside>
  );
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600 transition hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
    >
      {label}
    </button>
  );
}

function ViewTabBtn({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition ${
        active
          ? "bg-blue-600 text-white"
          : "bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
      }`}
    >
      {children}
    </button>
  );
}

function EyeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function SelectionMenu({
  x,
  y,
  onEdit,
  onAddToChat,
  onRewrite,
  onCopy,
  onMouseDown,
}: {
  x: number;
  y: number;
  onEdit: () => void;
  onAddToChat: () => void;
  onRewrite: () => void;
  onCopy: () => void;
  onMouseDown: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="menu"
      className="absolute z-20 min-w-[11rem] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      style={{ left: x, top: y }}
      onMouseDown={onMouseDown}
    >
      <SelectionMenuItem label="编辑" shortcut="⌘I" onClick={onEdit} accent />
      <SelectionMenuItem label="添加到对话" shortcut="⌘U" onClick={onAddToChat} />
      <SelectionMenuItem label="AI 改写选段" onClick={onRewrite} />
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      <SelectionMenuItem label="复制" onClick={onCopy} />
    </div>
  );
}

function SelectionMenuItem({
  label,
  shortcut,
  onClick,
  accent,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[11px] text-slate-700 transition hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span className="inline-flex items-center gap-1.5">
        {accent ? (
          <span className="text-emerald-500" aria-hidden>
            ✦
          </span>
        ) : null}
        {label}
      </span>
      {shortcut ? <span className="text-[10px] text-slate-400">{shortcut}</span> : null}
    </button>
  );
}
