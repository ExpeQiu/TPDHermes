"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolsContext?: string; // mcp_tphermes_* result prepended to user msg
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const STORAGE_KEY = "tphermes-chat-sessions";
const ACTIVE_KEY = "tphermes-chat-active";

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

// ─── SSE parser ───────────────────────────────────────────────────────────────

function parseSSELines(lines: string): string {
  let result = "";
  for (const line of lines.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]" || data === "") continue;
    try {
      const parsed = JSON.parse(data);
      // OpenAI-compatible: choices[0].delta.content
      const content =
        parsed.choices?.[0]?.delta?.content ??
        parsed.choices?.[0]?.message?.content ??
        parsed.content ??
        "";
      if (typeof content === "string") result += content;
    } catch {
      // skip malformed
    }
  }
  return result;
}

// ─── Auto-scroll ref ──────────────────────────────────────────────────────────

function useAutoScroll(depend: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth" });
  }, [depend]);
  return ref;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const API_BASE =
    process.env.NEXT_PUBLIC_HERMES_API_URL ??
    "http://localhost:8642/v1/chat/completions";
  const API_KEY =
    process.env.NEXT_PUBLIC_HERMES_API_KEY ?? "YOUR_KEY";

    // ─── Quick-create context key ──────────────────────────────────────────────
  const CHAT_INIT_KEY = "tphermes-chat-init";

  // ─── Initialise ────────────────────────────────────────────────────────────

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
      setSessions([first]);
      setActiveId(first.id);
    } else {
      setSessions(saved);
      setActiveId(active && saved.find((s) => s.id === active) ? active : saved[0].id);
    }
  }, []);

  const activeSession = sessions.find((s) => s.id === activeId);

  // ─── Quick-create: inject opener from sessionStorage ────────────────────────
  // Runs after the session above is ready; reads init data, pre-fills input,
  // and leaves the opener text in the input for the user to inspect/send.
  useEffect(() => {
    if (!activeId || !activeSession) return;
    // Only act on a fresh (empty) session coming from /create
    if (activeSession.messages.length > 0) return;

    try {
      const raw = sessionStorage.getItem(CHAT_INIT_KEY);
      if (!raw) return;
      const init = JSON.parse(raw) as {
        scenarioId: string;
        opener: string;
        timestamp: number;
      };
      // Expire after 30 minutes
      if (Date.now() - init.timestamp > 30 * 60 * 1000) {
        sessionStorage.removeItem(CHAT_INIT_KEY);
        return;
      }
      // Pre-fill the input with the scenario opener
      setInput(init.opener ?? "");
      sessionStorage.removeItem(CHAT_INIT_KEY);
    } catch {
      // ignore parse errors
    }
  }, [activeId, activeSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAndSet = useCallback(
    (updated: ChatSession[]) => {
      setSessions(updated);
      saveSessions(updated);
    },
    []
  );

  const selectSession = (id: string) => {
    setActiveId(id);
    localStorage.setItem(ACTIVE_KEY, id);
  };

  const createSession = () => {
    const s: ChatSession = {
      id: uuid(),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
    };
    const next = [s, ...sessions];
    saveAndSet(next);
    setActiveId(s.id);
    localStorage.setItem(ACTIVE_KEY, s.id);
  };

  const deleteSession = (id: string) => {
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === 0) {
      createSession();
      return;
    }
    saveAndSet(next);
    if (activeId === id) {
      setActiveId(next[0].id);
      localStorage.setItem(ACTIVE_KEY, next[0].id);
    }
  };

  const renameSession = (id: string, title: string) => {
    const next = sessions.map((s) => (s.id === id ? { ...s, title } : s));
    saveAndSet(next);
  };

  // ─── Send message ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !activeSession || streaming) return;

    // Build user message, prepending tools context if present
    const toolsContext = ""; // TODO: wire in mcp_tphermes_* results when available
    const userMsg: Message = {
      id: uuid(),
      role: "user",
      content: text,
      toolsContext,
    };

    const updated = sessions.map((s) => {
      if (s.id !== activeId) return s;
      return { ...s, messages: [...s.messages, userMsg] };
    });
    saveAndSet(updated);
    setInput("");

    // Build conversation history for API
    const history = updated
      .find((s) => s.id === activeId)!
      .messages.map((m) => ({
        role: m.role,
        content:
          m.role === "user" && m.toolsContext
            ? `${m.toolsContext}\n\n用户问题：${m.content}`
            : m.content,
      }));

    setStreaming(true);
    setError("");

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = uuid();
    // Optimistically add empty assistant message
    const withAssistant = updated.map((s) => {
      if (s.id !== activeId) return s;
      return {
        ...s,
        messages: [
          ...s.messages,
          { id: assistantId, role: "assistant" as const, content: "" },
        ],
      };
    });
    saveAndSet(withAssistant);

    let fullContent = "";

    fetch(API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: history,
        stream: true,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
        }
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const process = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              // Flush remaining buffer
              if (buffer) {
                fullContent += parseSSELines(buffer);
                // Update last assistant message
                const final = sessions.map((s) => {
                  if (s.id !== activeId) return s;
                  const msgs = [...s.messages];
                  const lastIdx = msgs.length - 1;
                  if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                    msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent };
                  }
                  return { ...s, messages: msgs };
                });
                saveAndSet(final);
              }
              setStreaming(false);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            const delta = parseSSELines(lines.join("\n"));
            if (delta) {
              fullContent += delta;
              const updated2 = sessions.map((s) => {
                if (s.id !== activeId) return s;
                const msgs = [...s.messages];
                const lastIdx = msgs.length - 1;
                if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                  msgs[lastIdx] = {
                    ...msgs[lastIdx],
                    content: msgs[lastIdx].content + delta,
                  };
                }
                return { ...s, messages: msgs };
              });
              saveAndSet(updated2);
            }

            if (!controller.signal.aborted) process();
          });
        };
        process();
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(`连接失败：${err.message}`);
        setStreaming(false);
        // Remove the empty assistant message on error
        const rollback = sessions.map((s) => {
          if (s.id !== activeId) return s;
          return { ...s, messages: s.messages.filter((m) => m.id !== assistantId) };
        });
        saveAndSet(rollback);
      });
  }, [input, activeSession, streaming, activeId, sessions, API_BASE, API_KEY, saveAndSet]);

  // Auto-title first exchange
  useEffect(() => {
    if (!activeSession) return;
    const msgs = activeSession.messages;
    if (
      activeSession.title === "新对话" &&
      msgs.length >= 2 &&
      msgs[0].role === "user"
    ) {
      const title = msgs[0].content.slice(0, 20) + (msgs[0].content.length > 20 ? "…" : "");
      renameSession(activeSession.id, title);
    }
  }, [activeSession]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Keyboard shortcut: Enter to send, Shift+Enter for newline ────────────

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const messagesEndRef = useAutoScroll(
    activeSession?.messages.map((m) => m.content).join("") ?? ""
  );

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen bg-slate-900 text-white overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
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
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => selectSession(s.id)}
              className={`group flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-slate-700/50 transition ${
                s.id === activeId
                  ? "bg-slate-700/70 text-white"
                  : "text-slate-400 hover:bg-slate-700/40 hover:text-white"
              }`}
            >
              <span className="text-xs">💬</span>
              <span className="text-sm flex-1 truncate">{s.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(s.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition text-xs"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main area ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
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
          {streaming && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              生成中
            </span>
          )}
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {(!activeSession || activeSession.messages.length === 0) && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <p className="text-4xl mb-4">💬</p>
              <p className="text-sm">开始一段新对话吧</p>
              <p className="text-xs mt-1 text-slate-600">
                基于 hermes-agent 智能问答
              </p>
            </div>
          )}

          {activeSession?.messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${
                msg.role === "user" ? "flex-row-reverse" : ""
              }`}
            >
              {/* Avatar */}
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

              {/* Bubble */}
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-tr-sm"
                    : "bg-slate-700 text-slate-200 rounded-tl-sm"
                }`}
              >
                {msg.content || (streaming && msg.role === "assistant" ? "" : "…")}
                {streaming && msg.role === "assistant" && msg.content === "" && (
                  <span className="inline-block w-1.5 h-3.5 bg-blue-400 ml-0.5 animate-pulse" />
                )}
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

        {/* Input area */}
        <div className="p-4 border-t border-slate-700 bg-slate-800/60">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，Enter 发送，Shift+Enter 换行…"
              rows={1}
              disabled={streaming}
              className="flex-1 bg-slate-700/60 border border-slate-600 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none transition disabled:opacity-50"
              style={{ maxHeight: "9rem", minHeight: "3rem", height: "auto" } as React.CSSProperties}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 144) + "px";
              }}
            />
            <button
              onClick={sendMessage}
              disabled={streaming || !input.trim()}
              className={`flex-shrink-0 px-5 py-3 rounded-xl font-medium text-sm transition ${
                streaming || !input.trim()
                  ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white"
              }`}
            >
              {streaming ? "…" : "发送"}
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
