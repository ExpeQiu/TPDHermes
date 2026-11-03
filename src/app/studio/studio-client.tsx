"use client";

import { useEffect, useMemo, useState } from "react";

import { ProjectFilesRail } from "@/components/project-files-rail";
import { apiGet, apiPost } from "@/lib/api";
import { decodeProjectFileSelectValue, type ProjectRecord } from "@/lib/chat-context";
import { fetchProjectFileDetail, fetchProjectFilesUnified, type ProjectFileDetail, type ProjectFileItem } from "@/lib/co-create-api";
import {
  STUDIO_SCENES,
  STUDIO_SKILLS,
  studioSkillById,
  studioSkillStatusLabel,
} from "@/lib/studio-skills";
import {
  FIELD_LABEL,
  SOURCE_TEXT,
  type FieldKey,
  type StudioLog,
  type StudioState,
  type TechCard,
  applyStudioCommand,
  createStudioState,
  emptyFields,
  quoteFor,
  selectCardField,
} from "@/lib/tech-card-studio";

type StudioTurnResponse = {
  state: StudioState;
  reply: string;
  driver: "hermes" | "mock";
  fallback_reason: string | null;
  log: StudioLog & { driver?: string; project_id?: string | null; file_id?: string | null; file_kind?: string | null };
};

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

const PROMPTS = ["提取技术卡", "查看缺口", "锁定当前卡", "合并同域", "合并氛围灯"];

function SourcePane({ quote }: { quote: string }) {
  const start = quote ? SOURCE_TEXT.indexOf(quote) : -1;
  if (start < 0) {
    return <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-200">{SOURCE_TEXT}</p>;
  }
  const end = start + quote.length;
  return (
    <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-200">
      {SOURCE_TEXT.slice(0, start)}
      <mark className="rounded bg-amber-300/80 px-0.5 text-slate-950 dark:bg-amber-300">{SOURCE_TEXT.slice(start, end)}</mark>
      {SOURCE_TEXT.slice(end)}
    </p>
  );
}

function FieldButton({
  card,
  field,
  active,
  onSelect,
}: {
  card: TechCard;
  field: FieldKey;
  active: boolean;
  onSelect: () => void;
}) {
  const value = card[field].trim();
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border px-2 py-1.5 text-left text-xs ${
        active
          ? "border-amber-400 bg-amber-100 text-slate-900 dark:bg-amber-300/20 dark:text-amber-50"
          : "border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
      }`}
    >
      <span className="block text-[10px] uppercase tracking-wide text-slate-500">{FIELD_LABEL[field]}</span>
      <span className="mt-0.5 block">{value || "未记载"}</span>
    </button>
  );
}

function driverLabel(driver: string, fallback: string | null): string {
  if (driver === "hermes") return "Hermes 内核";
  if (fallback) return "Mock 内核 · Hermes 未就绪";
  return "Mock 内核";
}

export default function StudioClient() {
  const [studio, setStudio] = useState<StudioState>(createStudioState);
  const [kernelLabel, setKernelLabel] = useState("内核连接中");
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "hello",
      role: "assistant",
      content: "这是技术卡核对验证。说「提取技术卡」，候选会出现在右侧。点字段可看原文，锁定后再次提取不会覆盖。",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [skillId, setSkillId] = useState("V04");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState("");
  const [includeProject, setIncludeProject] = useState(false);
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesRefreshKey, setProjectFilesRefreshKey] = useState(0);
  const [linkedFile, setLinkedFile] = useState<ProjectFileDetail | null>(null);
  const activeSkill = studioSkillById(skillId);
  const boundProjectId = includeProject ? projectId : "";
  const boundProject = projects.find((project) => project.id === boundProjectId) ?? null;
  const skillReady = activeSkill.status === "ready";

  const selected = studio.cards.find((card) => card.id === studio.selectedCardId) ?? null;
  const activeQuote = selected && studio.selectedField ? quoteFor(selected, studio.selectedField) : "";

  useEffect(() => {
    let cancelled = false;
    apiGet<ProjectRecord[]>("/projects/")
      .then((rows) => {
        if (!cancelled) setProjects(Array.isArray(rows) ? rows : []);
      })
      .catch((error) => {
        console.warn("[studio] 项目列表加载失败", error);
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!boundProjectId) {
      setProjectFiles([]);
      setProjectFilesLoading(false);
      return;
    }
    let cancelled = false;
    setProjectFilesLoading(true);
    fetchProjectFilesUnified(boundProjectId)
      .then((files) => {
        if (!cancelled) setProjectFiles(files);
      })
      .catch((error) => {
        console.warn("[studio] 项目文件加载失败", { project_id: boundProjectId, error });
        if (!cancelled) setProjectFiles([]);
      })
      .finally(() => {
        if (!cancelled) setProjectFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boundProjectId, projectFilesRefreshKey]);

  useEffect(() => {
    const decoded = fileKey ? decodeProjectFileSelectValue(fileKey) : null;
    if (!boundProjectId || !decoded) {
      setLinkedFile(null);
      return;
    }
    let cancelled = false;
    fetchProjectFileDetail(boundProjectId, decoded.id, decoded.kind)
      .then((detail) => {
        if (!cancelled) setLinkedFile(detail);
      })
      .catch((error) => {
        console.warn("[studio] 关联文件读取失败", { project_id: boundProjectId, file: fileKey, error });
        if (!cancelled) setLinkedFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [boundProjectId, fileKey]);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ driver: string }>("/studio/config")
      .then((config) => {
        if (!cancelled) setKernelLabel(driverLabel(config.driver, null));
      })
      .catch(() => {
        if (!cancelled) setKernelLabel("本地回退");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    const gaps = studio.cards.reduce((count, card) => count + emptyFields(card).length, 0);
    const locked = studio.cards.filter((card) => card.status === "locked").length;
    return `版本 ${studio.revision} · 卡片 ${studio.cards.length} · 锁定 ${locked} · 缺口 ${gaps}`;
  }, [studio]);

  function chooseSkill(id: string) {
    const skill = studioSkillById(id);
    setSkillId(skill.id);
    console.info("[studio]", { event: "studio.skill.select", skill_id: skill.id, status: skill.status });
  }

  async function commit(text: string, base: StudioState = studio) {
    const content = text.trim();
    if (!content || pending) return;
    if (!skillReady) {
      setMessages((current) => [
        ...current,
        { id: `user_${current.length}`, role: "user", content },
        {
          id: `assistant_${current.length}`,
          role: "assistant",
          content: `「${activeSkill.name}」还没有接入工作区。当前可验证的是技术卡提取与核对。`,
        },
      ]);
      setDraft("");
      return;
    }
    setPending(true);
    setDraft("");
    try {
      const linked = fileKey ? decodeProjectFileSelectValue(fileKey) : null;
      const result = await apiPost<StudioTurnResponse>("/studio/turn", {
        message: content,
        state: base,
        project_id: boundProjectId || null,
        file_id: linked?.id ?? null,
        file_kind: linked?.kind ?? null,
      });
      console.info("[studio]", result.log);
      setStudio(result.state);
      setKernelLabel(driverLabel(result.driver, result.fallback_reason));
      setMessages((current) => [
        ...current,
        { id: `user_${current.length}`, role: "user", content },
        { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
      ]);
    } catch (error) {
      const result = applyStudioCommand(base, content);
      console.info("[studio]", { ...result.log, driver: "local-fallback", error: String(error) });
      setStudio(result.state);
      setKernelLabel("本地回退");
      setMessages((current) => [
        ...current,
        { id: `user_${current.length}`, role: "user", content },
        { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
      ]);
    } finally {
      setPending(false);
    }
  }

  function lockCard(cardId: string) {
    const selected = selectCardField(studio, cardId, "definition");
    commit("锁定当前卡", selected);
  }

  const renderProjectFilesRail = (autoHide = false) => (
    <ProjectFilesRail
      scope="studio"
      autoHide={autoHide}
      projects={projects}
      projectId={boundProjectId}
      fileKey={fileKey}
      files={projectFiles}
      loading={projectFilesLoading}
      onProjectChange={(next) => {
        setProjectId(next);
        setIncludeProject(Boolean(next));
        setFileKey(null);
        setLinkedFile(null);
      }}
      onFileChange={setFileKey}
      onRefresh={() => setProjectFilesRefreshKey((value) => value + 1)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="flex max-h-52 min-h-0 w-full shrink-0 flex-col border-b border-slate-200 dark:border-slate-800 lg:max-h-none lg:h-full lg:w-60 lg:border-b-0 lg:border-r">
        <header className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <p className="text-xs text-slate-500">技能卡 · {STUDIO_SKILLS.length}</p>
          <h2 className="text-sm font-semibold">规划技能</h2>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 py-2">
          {STUDIO_SCENES.map((scene) => (
            <div key={scene}>
              <p className="px-1 pb-1 text-[10px] font-medium tracking-wide text-slate-500">{scene}</p>
              <div className="space-y-1">
                {STUDIO_SKILLS.filter((skill) => skill.scene === scene).map((skill) => {
                  const active = skill.id === activeSkill.id;
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => chooseSkill(skill.id)}
                      className={`w-full rounded-xl border px-2 py-1.5 text-left ${
                        active
                          ? "border-blue-400 bg-blue-50 dark:bg-blue-950/40"
                          : "border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-800 dark:hover:bg-slate-900"
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-slate-500">{skill.id}</span>
                        <span className="text-[10px] text-slate-500">{studioSkillStatusLabel(skill)}</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-800 dark:text-slate-100">{skill.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </aside>
      <details className="group shrink-0 border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40 lg:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>项目文件</span>
          <span className="text-xs text-slate-500 group-open:hidden">展开</span>
          <span className="hidden text-xs text-slate-500 group-open:inline">收起</span>
        </summary>
        <div className="h-[42vh] min-h-0 border-t border-slate-200 dark:border-slate-800">{renderProjectFilesRail()}</div>
      </details>
      <section className="flex h-[42%] min-h-0 w-full flex-col border-b border-slate-200 dark:border-slate-800 lg:h-full lg:w-[22rem] lg:shrink-0 lg:border-b-0 lg:border-r">
        <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="text-xs text-slate-500">
            {activeSkill.id} · {pending ? "内核处理中" : kernelLabel}
          </p>
          <h1 className="text-base font-semibold">{activeSkill.name}</h1>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-2xl px-3 py-2 text-sm leading-6 ${
                message.role === "user"
                  ? "ml-8 bg-blue-600 text-white"
                  : "mr-6 bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
              }`}
            >
              {message.content}
            </div>
          ))}
        </div>
        <form
          className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(draft);
          }}
        >
          <div className="flex flex-wrap gap-1.5">
            {PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={pending}
                onClick={() => void commit(prompt)}
                className="rounded-full border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
              >
                {prompt}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="输入指令"
              aria-label={`${activeSkill.name}指令`}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950"
            />
            <button type="submit" disabled={pending} className="rounded-xl bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-60">
              发送
            </button>
          </div>
        </form>
      </section>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <p className="text-xs text-slate-500">
              {activeSkill.id} · {activeSkill.name}
            </p>
            <h2 className="text-base font-semibold">{skillReady ? "可视化工作区" : "工作区尚未接入"}</h2>
          </div>
          <p className="text-xs text-slate-500">
            {boundProject ? `项目 ${boundProject.name}` : "未绑定项目"}
            {linkedFile ? ` · ${linkedFile.title}` : ""}
            {" · "}
            {summary}
          </p>
        </header>
        {studio.blockedReason ? (
          <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            {studio.blockedReason}
          </p>
        ) : null}
        {!skillReady ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <p className="text-sm leading-7 text-slate-600 dark:text-slate-300">
              {activeSkill.scene} · {activeSkill.phase} · {studioSkillStatusLabel(activeSkill)}。
              这张技能卡已列入规划，对话和可视化操作还没有接到内核。
            </p>
          </div>
        ) : null}
        {skillReady ? (
        <div className="grid min-h-0 flex-1 grid-rows-2 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-1">
          <div className="min-h-0 overflow-y-auto border-b border-slate-200 p-4 dark:border-slate-800 lg:border-b-0 lg:border-r">
            <p className="mb-2 text-xs text-slate-500">{linkedFile ? `关联文件 · ${linkedFile.title}` : "原文"}</p>
            {linkedFile ? (
              <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-200">
                {linkedFile.content?.trim() || "这份文件没有正文。"}
              </p>
            ) : (
              <SourcePane quote={activeQuote} />
            )}
          </div>
          <div className="min-h-0 overflow-y-auto p-4">
            <p className="mb-2 text-xs text-slate-500">技术卡</p>
            {studio.cards.length === 0 ? (
              <p className="text-sm text-slate-500">还没有候选。在左侧提取技术卡。</p>
            ) : (
              <div className="space-y-3">
                {studio.cards.map((card) => {
                  const activeCard = card.id === studio.selectedCardId;
                  return (
                    <article
                      key={card.id}
                      className={`rounded-2xl border p-3 ${
                        activeCard
                          ? "border-blue-400 bg-blue-50/70 dark:bg-blue-950/30"
                          : "border-slate-200 dark:border-slate-800"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold">{card.term}</h3>
                          <p className="text-xs text-slate-500">
                            {card.domain} · {card.status === "locked" ? "已锁定" : "候选"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => lockCard(card.id)}
                          className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-700"
                        >
                          锁定
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-1.5">
                        {(Object.keys(FIELD_LABEL) as FieldKey[]).map((field) => (
                          <FieldButton
                            key={field}
                            card={card}
                            field={field}
                            active={activeCard && studio.selectedField === field}
                            onSelect={() => setStudio(selectCardField(studio, card.id, field))}
                          />
                        ))}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        ) : null}
      </section>
      <div className="hidden h-full min-h-0 lg:flex">{renderProjectFilesRail(true)}</div>
    </div>
  );
}
