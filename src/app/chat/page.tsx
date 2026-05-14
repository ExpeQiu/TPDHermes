"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { apiV1 } from "@/lib/api";
import {
  buildToolsContext,
  ChatInit,
  ChatTransportConfig,
  ContextBlock,
  fetchChatBootstrap,
  ProjectRecord,
} from "@/lib/chat-context";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolsContext?: string;
  contextBlocks?: ContextBlock[];
  contextWarnings?: string[];
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

const STORAGE_KEY = "tphermes-chat-sessions";
const ACTIVE_KEY = "tphermes-chat-active";
const CHAT_INIT_KEY = "tphermes-chat-init";

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function parseSSELines(lines: string): string {
  let result = "";
  for (const line of lines.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]" || data === "") continue;
    try {
      const parsed = JSON.parse(data);
      const content =
        parsed.choices?.[0]?.delta?.content ??
        parsed.choices?.[0]?.message?.content ??
        parsed.content ??
        (parsed.error?.message ? `[错误] ${parsed.error.message}` : "");
      if (typeof content === "string") result += content;
    } catch {
      // skip malformed
    }
  }
  return result;
}

function useAutoScroll(depend: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [depend]);
  return ref;
}

function truncate(text: string, max = 180) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function titleFromSession(session: ChatSession | undefined): string {
  if (!session) return "对话";
  const firstUser = session.messages.find((msg) => msg.role === "user");
  if (!firstUser) return session.title;
  const text = firstUser.content.trim();
  return text.slice(0, 20) + (text.length > 20 ? "…" : "");
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [preparingContext, setPreparingContext] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [transport, setTransport] = useState<ChatTransportConfig | null>(null);
  const [bootstrapWarnings, setBootstrapWarnings] = useState<string[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [includeProjectContext, setIncludeProjectContext] = useState(true);
  const [includeKnowledgeContext, setIncludeKnowledgeContext] = useState(true);
  const [includeSkillsContext, setIncludeSkillsContext] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeIdRef = useRef<string | null>(null);

  const chatApiBase =
    process.env.NEXT_PUBLIC_CHAT_API_URL ??
    process.env.NEXT_PUBLIC_HERMES_API_URL ??
    apiV1("/chat/completions");
  const chatApiKey =
    process.env.NEXT_PUBLIC_CHAT_API_KEY ??
    process.env.NEXT_PUBLIC_HERMES_API_KEY ??
    "";

  const activeSession = sessions.find((s) => s.id === activeId);

  const saveAndSet = useCallback((updated: ChatSession[]) => {
    sessionsRef.current = updated;
    setSessions(updated);
    saveSessions(updated);
  }, []);

  const updateSession = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      const next = sessionsRef.current.map((session) =>
        session.id === sessionId ? updater(session) : session,
      );
      saveAndSet(next);
      return next;
    },
    [saveAndSet],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const saved = loadSessions();
    const active = localStorage.getItem(ACTIVE_KEY);
    if (saved.length === 0) {
      const first: ChatSession = {
        id: uuid(),
        title: "新对话",
        messages: [],
        createdAt: Date.now(),
      };
      saveSessions([first]);
      sessionsRef.current = [first];
      setSessions([first]);
      setActiveId(first.id);
    } else {
      sessionsRef.current = saved;
      setSessions(saved);
      setActiveId(active && saved.find((s) => s.id === active) ? active : saved[0].id);
    }
  }, []);

  useEffect(() => {
    fetchChatBootstrap()
      .then((data) => {
        setProjects(data.projects);
        setCollections(data.collections);
        setSkills(data.skills);
        setTransport(data.transport);
        setBootstrapWarnings(data.warnings);
        if (data.collections.length > 0) setSelectedCollection(data.collections[0]);
      })
      .catch((loadError) => {
        setBootstrapWarnings([`上下文配置加载失败：${String(loadError)}`]);
      });
  }, []);

  useEffect(() => {
    if (!activeId || !activeSession || activeSession.messages.length > 0) return;
    try {
      const raw = sessionStorage.getItem(CHAT_INIT_KEY);
      if (!raw) return;
      const init = JSON.parse(raw) as ChatInit;
      if (Date.now() - init.timestamp > 30 * 60 * 1000) {
        sessionStorage.removeItem(CHAT_INIT_KEY);
        return;
      }

      if (init.systemContext?.trim()) {
        updateSession(activeId, (session) => ({
          ...session,
          messages: [
            {
              id: uuid(),
              role: "system",
              content: `场景预设：\n${init.systemContext.trim()}`,
            },
          ],
        }));
      }

      setInput(init.opener ?? "");
      sessionStorage.removeItem(CHAT_INIT_KEY);
    } catch {
      // ignore parse errors
    }
  }, [activeId, activeSession, updateSession]);

  useEffect(() => {
    if (!activeSession || activeSession.title !== "新对话") return;
    const nextTitle = titleFromSession(activeSession);
    if (nextTitle !== activeSession.title) {
      updateSession(activeSession.id, (session) => ({ ...session, title: nextTitle }));
    }
  }, [activeSession, updateSession]);

  const selectSession = (id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
  };

  const createSession = () => {
    const session: ChatSession = {
      id: uuid(),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
    };
    const next = [session, ...sessionsRef.current];
    saveAndSet(next);
    setActiveId(session.id);
    localStorage.setItem(ACTIVE_KEY, session.id);
  };

  const deleteSession = (id: string) => {
    const next = sessionsRef.current.filter((s) => s.id !== id);
    if (next.length === 0) {
      createSession();
      return;
    }
    saveAndSet(next);
    if (activeIdRef.current === id) {
      setActiveId(next[0].id);
      localStorage.setItem(ACTIVE_KEY, next[0].id);
    }
  };

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    if (includeProjectContext && selectedProjectId) {
      const project = projects.find((item) => item.id === selectedProjectId);
      parts.push(`项目: ${project?.name ?? "已选"}`);
    }
    if (includeKnowledgeContext && selectedCollection) {
      parts.push(`知识库: ${selectedCollection}`);
    }
    if (includeSkillsContext) {
      parts.push(`技能快照: ${skills.length} 项`);
    }
    return parts;
  }, [
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    projects,
    selectedCollection,
    selectedProjectId,
    skills.length,
  ]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const sessionId = activeIdRef.current;
    if (!text || !sessionId || streaming || preparingContext) return;

    setError("");
    setPreparingContext(true);

    let contextWarnings: string[] = [];
    let contextBlocks: ContextBlock[] = [];
    let toolsContext = "";

    try {
      if (
        (includeProjectContext && selectedProjectId) ||
        (includeKnowledgeContext && selectedCollection) ||
        includeSkillsContext
      ) {
        const built = await buildToolsContext({
          query: text,
          projectId: selectedProjectId || undefined,
          collectionName: selectedCollection || undefined,
          includeProject: includeProjectContext,
          includeKnowledge: includeKnowledgeContext,
          includeSkills: includeSkillsContext,
          skillSnapshot: skills,
        });
        toolsContext = built.toolsContext;
        contextBlocks = built.blocks;
        contextWarnings = built.warnings;
      }
    } finally {
      setPreparingContext(false);
    }

    const userMsg: Message = {
      id: uuid(),
      role: "user",
      content: text,
      toolsContext,
      contextBlocks,
      contextWarnings,
    };

    const updated = updateSession(sessionId, (session) => ({
      ...session,
      messages: [...session.messages, userMsg],
    }));
    setInput("");

    const history =
      updated
        .find((session) => session.id === sessionId)
        ?.messages.map((message) => ({
          role: message.role,
          content:
            message.role === "user" && message.toolsContext
              ? `${message.toolsContext}\n\n用户问题：${message.content}`
              : message.content,
        })) ?? [];

    setStreaming(true);
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = uuid();
    updateSession(sessionId, (session) => ({
      ...session,
      messages: [
        ...session.messages,
        { id: assistantId, role: "assistant", content: "" },
      ],
    }));

    let fullContent = "";

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (chatApiKey) headers.Authorization = `Bearer ${chatApiKey}`;

      const res = await fetch(chatApiBase, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "hermes-agent",
          messages: history,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("响应流不可用");
      const decoder = new TextDecoder();
      let buffer = "";

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        const delta = parseSSELines(lines.join("\n"));
        if (delta) {
          fullContent += delta;
          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.id === assistantId
                ? { ...message, content: fullContent }
                : message,
            ),
          }));
        }
      }

      if (buffer) {
        const delta = parseSSELines(buffer);
        if (delta) {
          fullContent += delta;
        }
      }

      updateSession(sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === assistantId
            ? { ...message, content: fullContent || message.content }
            : message,
        ),
      }));
    } catch (sendError) {
      if ((sendError as Error).name !== "AbortError") {
        setError(`连接失败：${(sendError as Error).message}`);
        updateSession(sessionId, (session) => ({
          ...session,
          messages: session.messages.filter((message) => message.id !== assistantId),
        }));
      }
    } finally {
      setStreaming(false);
    }
  }, [
    chatApiBase,
    chatApiKey,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    input,
    preparingContext,
    selectedCollection,
    selectedProjectId,
    skills,
    streaming,
    updateSession,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const messagesEndRef = useAutoScroll(
    activeSession?.messages.map((m) => `${m.role}:${m.content}`).join("") ?? "",
  );

  return (
    <div className="flex h-screen bg-slate-900 text-white overflow-hidden">
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-0"
        } flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col transition-all overflow-hidden`}
      >
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-300">历史对话</span>
          <button
            onClick={createSession}
            className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition"
          >
            + 新对话
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => selectSession(session.id)}
              className={`group flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-slate-700/50 transition ${
                session.id === activeId
                  ? "bg-slate-700/70 text-white"
                  : "text-slate-400 hover:bg-slate-700/40 hover:text-white"
              }`}
            >
              <span className="text-xs">💬</span>
              <span className="text-sm flex-1 truncate">{session.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(session.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-slate-800/80">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-slate-400 hover:text-white transition text-sm"
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
          <Link href="/" className="text-slate-400 hover:text-white transition text-sm">
            ← 首页
          </Link>
          <h1 className="text-sm font-semibold text-white flex-1 truncate">
            {activeSession?.title ?? "对话"}
          </h1>
          {(preparingContext || streaming) && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              {preparingContext ? "准备上下文" : "生成中"}
            </span>
          )}
        </header>

        <div className="border-b border-slate-700 bg-slate-800/40">
          <div className="max-w-5xl mx-auto px-4 py-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3">
              <div className="text-xs text-slate-400 mb-2">聊天链路</div>
              <div className="text-sm text-white">
                {transport?.mode === "backend-proxy" ? "TPDHermes 后端代理" : "自定义聊天地址"}
              </div>
              <div className="text-xs text-slate-500 mt-1 break-all">
                {transport?.target ?? chatApiBase}
              </div>
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-slate-400">项目上下文</label>
                <input
                  type="checkbox"
                  checked={includeProjectContext}
                  onChange={(e) => setIncludeProjectContext(e.target.checked)}
                />
              </div>
              <select
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                <option value="">不注入项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-2">
                发送前显式调用 `mcp_tphermes_project_get`
              </p>
            </div>

            <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-3">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-slate-400">知识库与技能</label>
                <div className="flex items-center gap-3 text-xs text-slate-400">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={includeKnowledgeContext}
                      onChange={(e) => setIncludeKnowledgeContext(e.target.checked)}
                    />
                    KB
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={includeSkillsContext}
                      onChange={(e) => setIncludeSkillsContext(e.target.checked)}
                    />
                    技能
                  </label>
                </div>
              </div>
              <select
                value={selectedCollection}
                onChange={(e) => setSelectedCollection(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
              >
                {collections.length === 0 && <option value="">暂无集合</option>}
                {collections.map((collection) => (
                  <option key={collection} value={collection}>
                    {collection}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-2">
                发送前显式调用 `mcp_tphermes_kb_query` 与 `mcp_tphermes_workshop_list_skills`
              </p>
            </div>
          </div>

          <div className="max-w-5xl mx-auto px-4 pb-4">
            <div className="flex flex-wrap gap-2 text-xs">
              {contextSummary.length === 0 ? (
                <span className="px-2 py-1 rounded-full bg-slate-800 text-slate-500 border border-slate-700">
                  当前未启用额外上下文
                </span>
              ) : (
                contextSummary.map((item) => (
                  <span
                    key={item}
                    className="px-2 py-1 rounded-full bg-blue-900/30 text-blue-300 border border-blue-700/40"
                  >
                    {item}
                  </span>
                ))
              )}
            </div>

            {bootstrapWarnings.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                {bootstrapWarnings.join("；")}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {(!activeSession || activeSession.messages.length === 0) && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-sm">开始一段新对话吧</p>
              <p className="text-xs mt-1 text-slate-600">
                默认由 TPDHermes 后端转发到 Hermes-agent
              </p>
            </div>
          )}

          {activeSession?.messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
            >
              <div
                className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  msg.role === "user"
                    ? "bg-blue-600"
                    : msg.role === "system"
                      ? "bg-orange-600"
                      : "bg-slate-600"
                }`}
              >
                {msg.role === "user" ? "我" : msg.role === "system" ? "⚙" : "AI"}
              </div>

              <div className="max-w-[78%]">
                {msg.contextBlocks && msg.contextBlocks.length > 0 && (
                  <div className="mb-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3 text-xs text-slate-300">
                    <div className="font-medium text-slate-200 mb-2">
                      已注入 {msg.contextBlocks.length} 项显式上下文
                    </div>
                    <div className="space-y-2">
                      {msg.contextBlocks.map((block) => (
                        <div key={`${msg.id}-${block.tool}`} className="rounded-lg bg-slate-800/70 p-2">
                          <div className="text-blue-300">{block.tool}</div>
                          <div className="text-slate-200 mt-1">{block.title}</div>
                          <pre className="whitespace-pre-wrap text-slate-400 mt-1 font-sans">
                            {truncate(block.content, 260)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {msg.contextWarnings && msg.contextWarnings.length > 0 && (
                  <div className="mb-2 rounded-xl border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
                    {msg.contextWarnings.join("；")}
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-tr-sm"
                      : msg.role === "system"
                        ? "bg-orange-900/50 text-orange-100 rounded-tl-sm border border-orange-700/30"
                        : "bg-slate-700 text-slate-200 rounded-tl-sm"
                  }`}
                >
                  {msg.content || (streaming && msg.role === "assistant" ? "" : "…")}
                  {streaming && msg.role === "assistant" && msg.content === "" && (
                    <span className="inline-block w-1.5 h-3.5 bg-blue-400 ml-0.5 animate-pulse" />
                  )}
                </div>
              </div>
            </div>
          ))}

          {error && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-sm font-medium">
                !
              </div>
              <div className="max-w-[75%] rounded-2xl rounded-tl-sm bg-red-900/40 border border-red-700/50 px-4 py-2.5 text-sm text-red-300">
                ❌ {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-slate-700 bg-slate-800/60">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
              rows={1}
              disabled={streaming || preparingContext}
              className="flex-1 bg-slate-700/60 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none transition disabled:opacity-50"
              style={{ maxHeight: "9rem", minHeight: "3rem", height: "auto" } as React.CSSProperties}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 144) + "px";
              }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={streaming || preparingContext || !input.trim()}
              className={`flex-shrink-0 px-5 py-3 rounded-xl font-medium text-sm transition ${
                streaming || preparingContext || !input.trim()
                  ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white"
              }`}
            >
              {preparingContext ? "编排中" : streaming ? "…" : "发送"}
            </button>
            {streaming && (
              <button
                onClick={() => {
                  if (abortRef.current) abortRef.current.abort();
                  setStreaming(false);
                }}
                className="flex-shrink-0 px-4 py-3 rounded-xl text-sm text-slate-300 border border-slate-600 hover:bg-slate-700 transition"
              >
                停止
              </button>
            )}
          </div>
          <p className="text-xs text-slate-600 mt-2 text-center">
            AI 回复仅供参考，如有疑问请核实信息
          </p>
        </div>
      </div>
    </div>
  );
}
