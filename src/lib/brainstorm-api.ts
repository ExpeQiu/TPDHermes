import { apiGet, apiPost } from "@/lib/api";

export type DiscussionMode = "round_robin" | "parallel" | "debate";

export type DebateConfig = {
  pro_role_ids?: string[];
  con_role_ids?: string[];
  judge_role_id?: string | null;
};

export type BrainstormRunResult = {
  run_id: string;
  mode: string;
  coordinator: string;
  status: string;
  pack?: string | null;
  discussion_mode?: string | null;
  consensus_reached?: boolean | null;
  consensus_score?: number | null;
  stopped_at_round?: number | null;
  title: string;
  delivery_markdown: string;
  trajectory_markdown: string;
  warnings: string[];
  bridge: string;
  mock: boolean;
  project_id?: string | null;
  user_id?: string;
  meta?: Record<string, unknown>;
};

export type BrainstormHealth = {
  http_url: string;
  http_ok: boolean;
  http_error?: string | null;
  sdk_root?: string | null;
  sdk_ok: boolean;
  mock_default: boolean;
  ready: boolean;
  ai_owner?: string;
};

export async function fetchBrainstormHealth(): Promise<BrainstormHealth> {
  return apiGet<BrainstormHealth>("/brainstorm/health");
}

export async function runBrainstorm(params: {
  topic: string;
  project_id: string;
  pack?: string;
  rounds?: number;
  demo?: boolean | null;
  discussion_mode?: DiscussionMode;
  consensus_enabled?: boolean;
  consensus_threshold?: number;
  debate_config?: DebateConfig | null;
  moderator_enabled?: boolean;
  attachment_ids?: string[];
}): Promise<BrainstormRunResult> {
  const discussionMode = params.discussion_mode ?? "round_robin";
  console.info("[brainstorm] 发起圆桌（引擎=multi-agent）", {
    projectId: params.project_id,
    pack: params.pack ?? "nev-tech",
    rounds: params.rounds ?? 2,
    discussionMode,
    consensus: params.consensus_enabled ?? false,
    attachmentCount: params.attachment_ids?.length ?? 0,
    topic: params.topic.slice(0, 80),
  });
  const result = await apiPost<BrainstormRunResult>("/brainstorm/run", {
    topic: params.topic,
    project_id: params.project_id,
    pack: params.pack ?? "nev-tech",
    rounds: params.rounds ?? 2,
    demo: params.demo ?? null,
    discussion_mode: discussionMode,
    consensus_enabled: params.consensus_enabled ?? false,
    consensus_threshold: params.consensus_threshold ?? 0.7,
    debate_config: params.debate_config ?? null,
    moderator_enabled: params.moderator_enabled ?? true,
    attachment_ids: params.attachment_ids ?? [],
  });
  console.info("[brainstorm] 圆桌完成", {
    runId: result.run_id,
    bridge: result.bridge,
    mock: result.mock,
    discussionMode: result.discussion_mode,
    consensusReached: result.consensus_reached,
    contextChars: (result as { context_chars?: number }).context_chars,
  });
  return result;
}

export type BrainstormDepositResult = {
  id: string;
  project_id: string;
  title: string | null;
  status: string;
  entrypoint?: string | null;
};

export async function depositBrainstormOutput(params: {
  project_id: string;
  content: string;
  title?: string;
  topic?: string;
  ma_run_id?: string | null;
  discussion_mode?: string | null;
  pack?: string | null;
  mock?: boolean | null;
  trajectory_markdown?: string | null;
}): Promise<BrainstormDepositResult> {
  console.info("[brainstorm] 沉淀为项目输出", {
    projectId: params.project_id,
    maRunId: params.ma_run_id,
    contentLen: params.content.length,
  });
  const result = await apiPost<BrainstormDepositResult>(
    `/projects/${params.project_id}/outputs/deposit-from-brainstorm`,
    {
      content: params.content,
      title: params.title ?? null,
      topic: params.topic ?? null,
      ma_run_id: params.ma_run_id ?? null,
      discussion_mode: params.discussion_mode ?? null,
      pack: params.pack ?? null,
      mock: params.mock ?? null,
      trajectory_markdown: params.trajectory_markdown ?? null,
    },
  );
  console.info("[brainstorm] 沉淀完成", { outputId: result.id, status: result.status });
  return result;
}
