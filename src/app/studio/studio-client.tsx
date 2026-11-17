"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ProjectFilesRail } from "@/components/project-files-rail";
import { CutPotPanel } from "./cutpot-panel";
import { LocalAppFrame } from "./local-app-frame";
import { WorkbenchBoot } from "./workbench-boot";
import { ProductWorkbench } from "./product-workbench";
import { V04Workbench } from "./v04-workbench";
import { apiGet, apiPost } from "@/lib/api";
import { decodeProjectFileSelectValue, type ProjectRecord } from "@/lib/chat-context";
import { fetchProjectFileDetail, fetchProjectFilesUnified, type ProjectFileDetail, type ProjectFileItem } from "@/lib/co-create-api";
import {
  STUDIO_SCENES,
  STUDIO_SKILLS,
  isStudioSkillReleased,
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
  createStudioState,
  emptyFields,
  quoteFor,
  selectCardField,
} from "@/lib/tech-card-studio";

type StudioTurnResponse = {
  state: StudioState;
  reply: string;
  driver: "tpcstore" | "hermes" | "mock";
  source?: { id: string; text: string; version: string; sha256: string };
  fallback_reason: string | null;
  log: StudioLog & { driver?: string; project_id?: string | null; file_id?: string | null; file_kind?: string | null };
};

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

const PROMPTS = ["提取技术卡", "查看缺口", "锁定当前卡", "合并同域", "合并氛围灯"];

export function SourcePane({ quote, text = SOURCE_TEXT, lineStart }: { quote: string; text?: string; lineStart?: number }) {
  const offset = lineStart ? text.split("\n").slice(0, lineStart - 1).reduce((sum, line) => sum + line.length + 1, 0) : 0;
  const start = quote ? text.indexOf(quote, offset) : -1;
  if (start < 0) {
    return <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-200">{text}</p>;
  }
  const end = start + quote.length;
  return (
    <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-200">
      {text.slice(0, start)}
      <mark className="rounded bg-amber-300/80 px-0.5 text-slate-950 dark:bg-amber-300">{text.slice(start, end)}</mark>
      {text.slice(end)}
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
      {card.sources?.[field] ? <span className="block text-[10px] text-slate-500">L{card.sources[field]!.line_start}–L{card.sources[field]!.line_end}</span> : null}
    </button>
  );
}

function driverLabel(driver: string, fallback: string | null): string {
  if (driver === "tpcstore") return "TPCstore · 会话预览";
  if (driver === "hermes") return "Harness 内核";
  if (fallback) return "Mock 内核 · Harness 未就绪";
  return "Mock 内核";
}

export default function StudioClient({ initialProjectId = "" }: { initialProjectId?: string }) {
  const [studio, setStudio] = useState<StudioState>(createStudioState);
  const [kernelLabel, setKernelLabel] = useState("内核连接中");
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "hello",
      role: "assistant",
      content: "请选择项目资料后提取技术卡。候选与来源由 TPCstore 返回，当前仅保留会话预览。",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [skillId, setSkillId] = useState("V04");
  const [released, setReleased] = useState<Record<string, boolean> | null>(null);
  const [projectList, setProjectList] = useState<ProjectRecord[] | null>();
  const projects = projectList ?? [];
  const [projectId, setProjectId] = useState(initialProjectId);
  const [includeProject, setIncludeProject] = useState(Boolean(initialProjectId));
  const [demo] = useState(false);
  const [sourceSnapshot, setSourceSnapshot] = useState<StudioTurnResponse["source"]>();
  const requestEpoch = useRef(0);
  const [receiptSnapshot, setReceiptSnapshot] = useState<{
    scope: string;
    revision?: number;
    source: { title: string; version: string; sha256: string };
    cards: TechCard[];
  }>();
  const [workbenchFocus, setWorkbenchFocus] = useState<{ card_id: string; field?: string; receipt: string; scope: string }>();
  const [workbenchRevision, setWorkbenchRevision] = useState(0);
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFileItem[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [projectFilesRefreshKey, setProjectFilesRefreshKey] = useState(0);
  const [linkedFile, setLinkedFile] = useState<ProjectFileDetail | null>(null);
  const visibleSkills = useMemo(
    () => STUDIO_SKILLS.filter((skill) => isStudioSkillReleased(skill, released)),
    [released],
  );
  const activeSkill = visibleSkills.find((skill) => skill.id === skillId) ?? visibleSkills[0] ?? studioSkillById(skillId);
  const boundProjectId = includeProject ? projectId : "";
  const workbenchFile = fileKey ? decodeProjectFileSelectValue(fileKey) : null;
  const jobScope = boundProjectId && workbenchFile && !demo
    ? JSON.stringify([boundProjectId, workbenchFile.kind, workbenchFile.id])
    : "";
  const [recentJobs, setRecentJobs] = useState<{ id: string; label: string }[]>([]);
  const [job, setJob] = useState<{ id: string; scope: string } | null>(null);
  const submittingJob = useRef(false);
  useEffect(() => {
    if (!boundProjectId) return;
    const remembered = sessionStorage.getItem(`v04-file:${boundProjectId}`);
    if (remembered) setFileKey(remembered);
  }, [boundProjectId]);
  const boundProject = projects.find((project) => project.id === boundProjectId) ?? null;
  const cutpotSelected = activeSkill.id === "V17";
  const cutpotScopePending = Boolean(boundProjectId) && projectList === undefined;
  const cutpotProjectId = projectList && !boundProject ? "" : boundProjectId;
  const cutpotUsingPersonalWorkspace = Boolean(boundProjectId && !cutpotProjectId);
  const localApp = activeSkill.id === "V14" || activeSkill.id === "V18" || activeSkill.id === "V22" ? activeSkill.id : null;
  const productApp = activeSkill.id === "V05" || activeSkill.id === "V07" || activeSkill.id === "V10" ? activeSkill.id : null;
  const [cutpotConnection, setCutpotConnection] = useState<{ projectId: string; url: string; error?: string }>();
  const handleCutpotUrl = useCallback((url: string, error?: string) => {
    setCutpotConnection({ projectId: cutpotProjectId, url, error });
  }, [cutpotProjectId]);
  const currentCutpotConnection = !cutpotScopePending && cutpotConnection?.projectId === cutpotProjectId
    ? cutpotConnection
    : undefined;
  const cutpotUrl = currentCutpotConnection?.url;
  const cutpotError = currentCutpotConnection?.error;
  const cutpotEditorUrl = useMemo(() => {
    if (!cutpotUrl) return "";
    try {
      const parsed = new URL(cutpotUrl);
      const allowedHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === window.location.hostname;
      if (parsed.protocol !== "http:" || !allowedHost || parsed.pathname !== "/editor") return "";
      return `${parsed.origin}/editor`;
    } catch {
      return "";
    }
  }, [cutpotUrl]);
  const skillReady = activeSkill.id === "V04" && activeSkill.status === "ready";

  const selected = studio.cards.find((card) => card.id === studio.selectedCardId) ?? null;
  const activeQuote = selected && studio.selectedField ? quoteFor(selected, studio.selectedField) : "";

  useEffect(() => {
    requestEpoch.current += 1;
    setStudio(createStudioState());
    setSourceSnapshot(undefined);
    const content = cutpotSelected
      ? "可以直接输入工程指令，例如查看工程或修改名称。未选项目时使用本机工作区，选中项目后再写入该项目。"
      : localApp
        ? "工作台显示在右侧。若本机服务未启动，右栏会给出地址。"
      : productApp
        ? (boundProjectId ? "可以查看工程或载入示例。交给下一张技能卡时写入工程文件；从上一张卡导入时，先在项目文件里选中那份工程文件。" : "请先在项目文件中绑定项目。")
      : demo
        ? "样本演示已开启，不使用项目资料。"
        : "选择项目资料后，可以对话提取技术卡、查看已保存候选或列出缺口。工作台显示在右侧。";
    setMessages([{ id: "context", role: "assistant", content }]);
  }, [boundProjectId, fileKey, demo, cutpotSelected, localApp, productApp]);

  useEffect(() => {
    let cancelled = false;
    apiGet<ProjectRecord[]>("/projects/")
      .then((rows) => {
        if (!cancelled) setProjectList(Array.isArray(rows) ? rows : null);
      })
      .catch((error) => {
        console.warn("[studio] 项目列表加载失败", error);
        if (!cancelled) setProjectList(null);
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
  }, [boundProjectId, fileKey, projectFilesRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ skills?: { id: string; released: boolean }[] }>("/system/studio-skills")
      .then((payload) => {
        if (cancelled || !Array.isArray(payload.skills)) return;
        const next: Record<string, boolean> = {};
        for (const row of payload.skills) next[row.id] = Boolean(row.released);
        setReleased(next);
      })
      .catch((error) => {
        console.warn("[studio] 技能卡释放配置读取失败，仅显示可验证卡片", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (visibleSkills.length === 0) return;
    if (!visibleSkills.some((skill) => skill.id === skillId)) {
      setSkillId(visibleSkills[0].id);
    }
  }, [skillId, visibleSkills]);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ driver: string; connected: boolean; configured: boolean; reason?: string }>("/studio/config")
      .then((config) => {
        if (!cancelled) setKernelLabel(config.connected ? config.configured ? "TPCstore 已连接 · 模型鉴权待调用验证" : "TPCstore 已连接 · 模型未配置" : config.reason || "TPCstore 未连接");
      })
      .catch(() => {
        if (!cancelled) setKernelLabel("TPCstore 连接检查失败");
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

  useEffect(() => {
    setRecentJobs(jobScope ? JSON.parse(sessionStorage.getItem(`v04-receipts:${jobScope}`) ?? "[]") : []);
    if (!jobScope) return;
    const pending = sessionStorage.getItem(`v04-job:${jobScope}`);
    if (pending) {
      const { id } = JSON.parse(pending) as { id: string };
      setJob({ id, scope: jobScope });
    }
  }, [jobScope]);

  useEffect(() => {
    if (!job || job.scope !== jobScope || !workbenchFile) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const query = new URLSearchParams({
      project_id: boundProjectId, file_id: workbenchFile.id, file_kind: workbenchFile.kind,
    });
    const poll = async () => {
      try {
        const saved = sessionStorage.getItem(`v04-job:${job.scope}`);
        const submission = saved ? JSON.parse(saved) as { id: string; message?: string } : null;
        if (submission?.message) {
          await apiPost("/studio/workbench/jobs", {
            request_id: job.id, message: submission.message,
            project_id: boundProjectId, file_id: workbenchFile.id, file_kind: workbenchFile.kind,
          });
          sessionStorage.setItem(`v04-job:${job.scope}`, JSON.stringify({ id: job.id }));
        }
        const receipt = await apiGet<{
          status: string;
          result?: {
            reply?: string;
            revision?: number;
            focus?: { card_id: string; field?: string };
            snapshot?: { source: { title: string; version: string; sha256: string }; cards: TechCard[] };
          };
        }>(`/studio/workbench/jobs/${job.id}?${query}`);
        if (!active) return;
        if (receipt.status === "running") {
          timer = setTimeout(poll, 1200);
          return;
        }
        const result = receipt.result;
        if (result?.snapshot) {
          setReceiptSnapshot({ ...result.snapshot, revision: result.revision, scope: job.scope });
        }
        setMessages((current) => [...current, {
          id: job.id, role: "assistant", content: result?.reply ?? "执行结果暂不可确认，请查看工作台。",
        }]);
        if (result?.revision !== undefined) setWorkbenchRevision(result.revision);
        if (result?.focus) setWorkbenchFocus({ ...result.focus, receipt: job.id, scope: job.scope });
        const key = `v04-receipts:${job.scope}`;
        const previous = JSON.parse(sessionStorage.getItem(key) ?? "[]") as { id: string; label: string }[];
        if (!previous.some((item) => item.id === job.id)) {
          const next = [{ id: job.id, label: result?.reply?.split("\n")[0] ?? "结果暂不可确认" }, ...previous].slice(0, 20);
          sessionStorage.setItem(key, JSON.stringify(next));
          setRecentJobs(next);
        }
        sessionStorage.removeItem(`v04-job:${job.scope}`);
        setJob(null);
      } catch {
        if (!active) return;
        setKernelLabel("任务回执连接中断，正在重连");
        timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [job, jobScope, boundProjectId, workbenchFile?.id, workbenchFile?.kind]);

  function chooseSkill(id: string) {
    const skill = studioSkillById(id);
    setSkillId(skill.id);
    console.info("[studio]", { event: "studio.skill.select", skill_id: skill.id, status: skill.status });
  }

  async function commit(text: string, base: StudioState = studio) {
    const content = text.trim();
    if (!content || pending || job?.scope === jobScope || (cutpotSelected && cutpotScopePending)) return;
    if (cutpotSelected) {
      setPending(true);
      setDraft("");
      const epoch = requestEpoch.current;
      try {
        const result = await apiPost<{ reply: string }>("/studio/cutpot/chat", {
          project_id: cutpotProjectId || null,
          message: content,
        });
        if (epoch !== requestEpoch.current) return;
        console.info("[studio]", { event: "studio.cutpot.instruction", project_id: cutpotProjectId || null });
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
        ]);
      } catch (error) {
        if (epoch !== requestEpoch.current) return;
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: error instanceof Error ? error.message : String(error) },
        ]);
      } finally {
        setPending(false);
      }
      return;
    }
    if (localApp) {
      setPending(true);
      setDraft("");
      const epoch = requestEpoch.current;
      try {
        const result = await apiGet<{ ready: boolean; url: string; message?: string; name: string }>(`/studio/local-apps/${localApp}`);
        if (epoch !== requestEpoch.current) return;
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: result.ready ? `${result.name} 已在右侧打开：${result.url}` : (result.message || "本机工作台未就绪") },
        ]);
      } catch (error) {
        if (epoch !== requestEpoch.current) return;
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: error instanceof Error ? error.message : String(error) },
        ]);
      } finally {
        setPending(false);
      }
      return;
    }
    if ((skillReady || productApp) && (content === "写入工程文件" || content === "从工程文件导入")) {
      const product = productApp ?? "V04";
      if (!boundProjectId) {
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: "请先在项目文件中绑定项目。" },
        ]);
        setDraft("");
        return;
      }
      const linked = fileKey ? decodeProjectFileSelectValue(fileKey) : null;
      if (content === "从工程文件导入" && linked?.kind !== "output") {
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: "请在项目文件中选择上游技能卡写入的工程文件。" },
        ]);
        setDraft("");
        return;
      }
      if (product === "V04" && !linked) {
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: "请先选择技术卡正在使用的项目资料。" },
        ]);
        setDraft("");
        return;
      }
      setPending(true);
      setDraft("");
      const epoch = requestEpoch.current;
      try {
        const result = await apiPost<{ reply: string; revision?: number }>("/studio/engineering", {
          action: content === "写入工程文件" ? "export" : "import",
          product,
          project_id: boundProjectId,
          file_id: linked?.id,
          file_kind: linked?.kind,
        });
        if (epoch !== requestEpoch.current) return;
        console.info("[studio]", { event: "studio.engineering", product, project_id: boundProjectId, action: content });
        if (typeof result.revision === "number") setWorkbenchRevision(result.revision);
        setProjectFilesRefreshKey((value) => value + 1);
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
        ]);
      } catch (error) {
        if (epoch !== requestEpoch.current) return;
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: error instanceof Error ? error.message : String(error) },
        ]);
      } finally {
        setPending(false);
      }
      return;
    }
    if (productApp) {
      if (!boundProjectId) {
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: "请先在项目文件中绑定项目。" },
        ]);
        setDraft("");
        return;
      }
      setPending(true);
      setDraft("");
      const epoch = requestEpoch.current;
      try {
        const result = await apiPost<{ reply: string; revision?: number }>(`/studio/apps/${productApp}/chat`, {
          project_id: boundProjectId,
          message: content,
        });
        if (epoch !== requestEpoch.current) return;
        console.info("[studio]", { event: "studio.app.instruction", product: productApp, project_id: boundProjectId });
        setKernelLabel(`TPCstore · ${productApp}`);
        if (typeof result.revision === "number") setWorkbenchRevision(result.revision);
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
        ]);
      } catch (error) {
        if (epoch !== requestEpoch.current) return;
        setMessages((current) => [
          ...current,
          { id: `user_${current.length}`, role: "user", content },
          { id: `assistant_${current.length}`, role: "assistant", content: error instanceof Error ? error.message : String(error) },
        ]);
      } finally {
        setPending(false);
      }
      return;
    }
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
    const epoch = requestEpoch.current;
    try {
      const linked = fileKey ? decodeProjectFileSelectValue(fileKey) : null;
      if (!demo && (!boundProjectId || !linked)) throw new Error("请选择项目和资料，或显式开启样本演示。");
      if (!demo && linked) {
        if (submittingJob.current || job?.scope === jobScope) return;
        submittingJob.current = true;
        const key = `v04-job:${jobScope}`;
        const requestId = crypto.randomUUID();
        sessionStorage.setItem(key, JSON.stringify({ id: requestId, message: content }));
        try {
          await apiPost("/studio/workbench/jobs", {
            request_id: requestId,
            message: content,
            project_id: boundProjectId,
            file_id: linked.id,
            file_kind: linked.kind,
          });
          sessionStorage.setItem(key, JSON.stringify({ id: requestId }));
        } catch (failure) {
          if (!(failure instanceof TypeError)) {
            sessionStorage.removeItem(key);
            throw failure;
          }
        } finally {
          submittingJob.current = false;
        }
        if (epoch !== requestEpoch.current) return;
        setJob({ id: requestId, scope: jobScope });
        setKernelLabel("Hermes-agent · V04 工作台");
        setMessages((current) => [...current, { id: requestId + "-user", role: "user", content }]);
        return;
      }
      const result = await apiPost<StudioTurnResponse>("/studio/turn", {
        message: content,
        state: base,
        project_id: demo ? null : boundProjectId || null,
        file_id: demo ? null : linked?.id ?? null,
        file_kind: demo ? null : linked?.kind ?? null,
        demo,
      });
      if (epoch !== requestEpoch.current) return;
      console.info("[studio]", result.log);
      setStudio(result.state);
      setSourceSnapshot(result.source);
      setKernelLabel(driverLabel(result.driver, result.fallback_reason));
      setMessages((current) => [
        ...current,
        { id: `user_${current.length}`, role: "user", content },
        { id: `assistant_${current.length}`, role: "assistant", content: result.reply },
      ]);
    } catch (error) {
      if (epoch !== requestEpoch.current) return;
      setKernelLabel("调用未完成 · 未采用新结果");
      setMessages((current) => [
        ...current,
        { id: `user_${current.length}`, role: "user", content },
        { id: `assistant_${current.length}`, role: "assistant", content: error instanceof Error ? error.message : String(error) },
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
      onFileChange={(next) => {
        setFileKey(next);
        if (boundProjectId) {
          const key = `v04-file:${boundProjectId}`;
          if (next) sessionStorage.setItem(key, next);
          else sessionStorage.removeItem(key);
        }
      }}
      onRefresh={() => setProjectFilesRefreshKey((value) => value + 1)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="flex max-h-52 min-h-0 w-full shrink-0 flex-col border-b border-slate-200 dark:border-slate-800 lg:max-h-none lg:h-full lg:w-60 lg:border-b-0 lg:border-r">
        <header className="flex h-14 shrink-0 flex-col justify-center border-b border-slate-200 px-3 dark:border-slate-800">
          <p className="truncate text-xs leading-4 text-slate-500">技能卡 · {visibleSkills.length}</p>
          <h2 className="truncate text-sm font-semibold leading-5">已开放</h2>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 py-2">
          {visibleSkills.length === 0 ? (
            <p className="px-1 text-xs leading-5 text-slate-500">当前没有对用户开放的技能卡。请在成长的技能卡里打开后再使用。</p>
          ) : null}
          {STUDIO_SCENES.map((scene) => {
            const sceneSkills = visibleSkills.filter((skill) => skill.scene === scene);
            if (sceneSkills.length === 0) return null;
            return (
            <div key={scene}>
              <p className="px-1 pb-1 text-[10px] font-medium tracking-wide text-slate-500">{scene}</p>
              <div className="space-y-1">
                {sceneSkills.map((skill) => {
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
            );
          })}
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
        <header className="flex h-14 shrink-0 flex-col justify-center border-b border-slate-200 px-4 dark:border-slate-800">
          <p className="truncate text-xs leading-4 text-slate-500">
            {activeSkill.id} · {(pending || job?.scope === jobScope) ? "内核处理中" : kernelLabel}
            {linkedFile ? ` · ${linkedFile.title}` : ""}
          </p>
          <h1 className="truncate text-sm font-semibold leading-5">{activeSkill.name}</h1>
        </header>
        {jobScope && !job && recentJobs.length ? (
          <label className="border-b border-slate-200 px-4 py-1.5 text-xs dark:border-slate-800">
            <span className="sr-only">历史任务回执</span>
            <select value="" onChange={(event) => {
              const id = event.target.value;
              if (id) setJob({ id, scope: jobScope });
            }}>
              <option value="">查看历史任务回执</option>
              {recentJobs.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        ) : null}
        {cutpotSelected && !cutpotScopePending ? (
          <CutPotPanel
            key={cutpotProjectId || "unbound"}
            projectId={cutpotProjectId}
            onUrlChange={handleCutpotUrl}
          />
        ) : null}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-6 ${
                message.role === "user"
                  ? "ml-8 bg-blue-600 text-white"
                  : "mr-6 bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
              }`}
            >
              {message.content}
            </div>
          ))}
        </div>
        {receiptSnapshot?.scope === jobScope ? (
          <details className="max-h-48 overflow-y-auto border-t border-slate-200 px-3 py-2 text-xs">
            <summary className="cursor-pointer">结果快照 · 版本 {receiptSnapshot.revision}</summary>
            <p className="my-2">{receiptSnapshot.source.title} · 原文版本 {receiptSnapshot.source.version}</p>
            {receiptSnapshot.cards.map((card) => (
              <article key={card.id} className="my-2">
                <h3 className="font-semibold">{card.term}</h3>
                {(Object.keys(FIELD_LABEL) as FieldKey[]).map((field) => {
                  const anchor = card.sources?.[field];
                  return <p key={field}>{FIELD_LABEL[field]}：{card[field] || "待补"}
                    {anchor ? `（原文 ${anchor.line_start}–${anchor.line_end} 行：${anchor.quote}）` : ""}
                  </p>;
                })}
              </article>
            ))}
          </details>
        ) : null}
        <form
          className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(event) => {
            event.preventDefault();
            void commit(draft);
          }}
        >
          <div className="flex flex-wrap gap-1.5">
            {(cutpotSelected ? ["查看工程"] : localApp ? ["查看工作台"] : productApp ? ["查看工程", "载入示例", "从工程文件导入", "写入工程文件"] : demo ? PROMPTS : ["提取技术卡", "查看缺口", "查看工作区", "写入工程文件"]).map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={pending || (cutpotSelected && cutpotScopePending)}
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
            <button type="submit" disabled={pending || (cutpotSelected && cutpotScopePending)} className="rounded-xl bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-60">
              发送
            </button>
          </div>
        </form>
      </section>

      {cutpotSelected ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {cutpotUsingPersonalWorkspace ? (
            <p className="shrink-0 border-b px-3 py-2 text-xs text-slate-500">
              链接中的项目不可用，已切换到个人 CutPot 工作区。
            </p>
          ) : null}
          {cutpotEditorUrl ? (
            <iframe
              title="CutPot 编辑器"
              src={cutpotEditorUrl}
              className="min-h-0 w-full flex-1 border-0 bg-slate-950"
              onLoad={() => console.info("[studio]", { event: "studio.cutpot.embed", url: cutpotEditorUrl })}
            />
          ) : (
            <WorkbenchBoot
              title="正在打开 CutPot"
              progress={cutpotError ? 100 : 40}
              message={cutpotError || "正在连接本机工作台…"}
              failed={Boolean(cutpotError)}
            />
          )}
        </section>
      ) : localApp ? (
        <section className="flex min-h-80 min-w-0 flex-1 flex-col">
          <LocalAppFrame key={localApp} product={localApp === "V22" ? "V22" : localApp === "V18" ? "V18" : "V14"} />
        </section>
      ) : productApp ? (
        <section className="flex min-h-80 min-w-0 flex-1 flex-col">
          <ProductWorkbench
            key={`${productApp}:${boundProjectId || "unbound"}`}
            product={productApp === "V07" ? "V07" : productApp === "V10" ? "V10" : "V05"}
            projectId={boundProjectId}
            revision={workbenchRevision}
          />
        </section>
      ) : !demo && workbenchFile && boundProjectId && skillReady ? (
        <section className="flex min-h-80 min-w-0 flex-1 flex-col">
          <V04Workbench
            key={JSON.stringify([boundProjectId, workbenchFile.kind, workbenchFile.id])}
            projectId={boundProjectId}
            fileId={workbenchFile.id}
            fileKind={workbenchFile.kind}
            revision={workbenchRevision}
            focus={workbenchFocus?.scope === jobScope ? workbenchFocus : undefined}
          />
        </section>
      ) : !demo && skillReady ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col p-4">
          <h2 className="text-base font-semibold">技术卡工作台</h2>
          <p className="mt-2 text-sm text-slate-500">选择项目资料后，工作台显示在这里。</p>
        </section>
      ) : (
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
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
          <span>{demo ? "样本演示" : "会话预览 · 未持久保存 · 未审核"}{sourceSnapshot ? ` · 来源版本 ${sourceSnapshot.version}` : ""}</span>
          <button type="button" disabled={pending} onClick={() => { requestEpoch.current += 1; setStudio(createStudioState()); setSourceSnapshot(undefined); }} className="underline disabled:opacity-50">清空预览</button>
        </div>
        {studio.issues?.length ? <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{studio.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div> : null}
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
            <SourcePane quote={activeQuote} text={demo ? SOURCE_TEXT : sourceSnapshot?.text ?? linkedFile?.content ?? "请选择资料。"} lineStart={studio.selectedField ? selected?.sources?.[studio.selectedField]?.line_start : undefined} />
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
      )}
      <div className="hidden h-full min-h-0 lg:flex">{renderProjectFilesRail(true)}</div>
    </div>
  );
}
