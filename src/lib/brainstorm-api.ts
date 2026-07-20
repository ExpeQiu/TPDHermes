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
  job_id?: string;
  live_turns?: Array<{
    id?: string;
    kind?: string;
    speaker?: string;
    badge?: string;
    content?: string;
  }>;
};

export type BrainstormLiveTurn = {
  id?: string;
  kind?: string;
  speaker?: string;
  badge?: string;
  content?: string;
};

export type BrainstormJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed" | string;
  created_at?: string;
  updated_at?: string;
  params_summary?: Record<string, unknown>;
  error?: string | null;
  result?: BrainstormRunResult | null;
  turns?: BrainstormLiveTurn[];
  ma_run_id?: string | null;
  title?: string | null;
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

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_MS = 15 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBrainstormHealth(): Promise<BrainstormHealth> {
  return apiGet<BrainstormHealth>("/brainstorm/health");
}

export async function fetchBrainstormJob(jobId: string): Promise<BrainstormJobStatus> {
  return apiGet<BrainstormJobStatus>(`/brainstorm/jobs/${jobId}`);
}

/**
 * 发起圆桌：默认异步入队并轮询，避免 live 模式 >120s 被客户端断连（表现为 503/499）。
 */
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
  onJobUpdate?: (job: BrainstormJobStatus) => void;
}): Promise<BrainstormRunResult> {
  const discussionMode = params.discussion_mode ?? "round_robin";
  console.info("[brainstorm] 发起圆桌（引擎=multi-agent，异步）", {
    projectId: params.project_id,
    pack: params.pack ?? "tech-ip",
    rounds: params.rounds ?? 2,
    discussionMode,
    consensus: params.consensus_enabled ?? false,
    attachmentCount: params.attachment_ids?.length ?? 0,
    topic: params.topic.slice(0, 80),
  });

  const started = await apiPost<{
    job_id?: string;
    status?: string;
    async?: boolean;
    poll_path?: string;
  } & Partial<BrainstormRunResult>>("/brainstorm/run", {
    topic: params.topic,
    project_id: params.project_id,
    pack: params.pack ?? "tech-ip",
    rounds: params.rounds ?? 2,
    demo: params.demo ?? null,
    discussion_mode: discussionMode,
    consensus_enabled: params.consensus_enabled ?? false,
    consensus_threshold: params.consensus_threshold ?? 0.7,
    debate_config: params.debate_config ?? null,
    moderator_enabled: params.moderator_enabled ?? true,
    attachment_ids: params.attachment_ids ?? [],
    wait: false,
  });

  // 兼容旧后端同步返回
  if (!started.async && started.delivery_markdown != null) {
    console.info("[brainstorm] 圆桌完成（同步兼容）", {
      runId: started.run_id,
      bridge: started.bridge,
      mock: started.mock,
    });
    return started as BrainstormRunResult;
  }

  const jobId = started.job_id;
  if (!jobId) {
    throw new Error("头脑风暴未返回 job_id，无法轮询进度");
  }

  const deadline = Date.now() + POLL_MAX_MS;
  let lastStatus = started.status || "queued";
  console.info("[brainstorm] 已入队，开始轮询", { jobId, status: lastStatus });

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const job = await fetchBrainstormJob(jobId);
    if (job.status !== lastStatus) {
      console.info("[brainstorm] 任务状态变更", {
        jobId,
        from: lastStatus,
        to: job.status,
      });
      lastStatus = job.status;
    }
    params.onJobUpdate?.(job);

    if (job.status === "completed") {
      if (!job.result) {
        throw new Error("头脑风暴任务完成但无结果");
      }
      console.info("[brainstorm] 圆桌完成", {
        jobId,
        runId: job.result.run_id,
        bridge: job.result.bridge,
        mock: job.result.mock,
        discussionMode: job.result.discussion_mode,
        consensusReached: job.result.consensus_reached,
      });
      return job.result;
    }
    if (job.status === "failed") {
      throw new Error(job.error || "头脑风暴任务失败");
    }
  }

  throw new Error(`头脑风暴超时（>${POLL_MAX_MS / 60000} 分钟），job=${jobId}`);
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
