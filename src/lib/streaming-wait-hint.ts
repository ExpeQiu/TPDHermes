/** 首次对话加载提示：不暴露具体 collection 规范名，统一为产品侧「技术推广知识库」 */
const KB_LOADING_DISPLAY_NAME = "技术推广知识库";

export type StreamingWaitHintOptions = {
  isFirstTurn: boolean;
  includeProject: boolean;
  phase?: string;
};

export function buildStreamingWaitHint(options: StreamingWaitHintOptions): string {
  if (options.phase === "co_create_draft") {
    return "写稿模式：跳过预检索，Agent 将按需查库并生成正文";
  }
  if (options.phase === "kb_prefetch") {
    if (options.includeProject) {
      return `Agent 正在检索${KB_LOADING_DISPLAY_NAME}、项目上下文与引用文件`;
    }
    return `Agent 正在检索${KB_LOADING_DISPLAY_NAME}`;
  }
  if (options.phase === "kb_prefetch_querying") {
    return `Agent 正在查询${KB_LOADING_DISPLAY_NAME}`;
  }
  if (options.phase === "kb_prefetch_cross_collection") {
    return `Agent 正在扩大${KB_LOADING_DISPLAY_NAME}检索范围`;
  }
  if (options.phase === "kb_prefetch_heartbeat") {
    return `Agent 仍在检索${KB_LOADING_DISPLAY_NAME}，请稍候`;
  }
  if (options.phase === "kb_prefetch_timeout") {
    return `知识库预检索耗时过长，Agent 正在跳过该步骤继续生成`;
  }
  if (options.phase === "agent_generating") {
    return options.isFirstTurn ? "Agent 正在生成回复与文件修改方案" : "Agent 正在生成回复";
  }
  if (options.phase === "agent_waiting_first_token") {
    return "Agent 已开始生成，正在等待首批输出";
  }
  if (options.phase === "agent_streaming") {
    return "Agent 正在持续生成内容";
  }
  if (options.phase === "fast_path_generating") {
    return "正在通过快速通道直接生成首答";
  }
  if (options.phase === "fast_path_streaming") {
    return "快速通道已开始持续输出";
  }
  if (!options.isFirstTurn) {
    return "Agent 正在生成回复";
  }

  if (options.includeProject) {
    return `首次对话时间会稍长，Agent 正在加载${KB_LOADING_DISPLAY_NAME}与项目上下文`;
  }
  return `首次对话时间会稍长，Agent 正在加载${KB_LOADING_DISPLAY_NAME}`;
}

export function isFirstAssistantTurn(messages: { role: string }[]): boolean {
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  return userCount === 1 && assistantCount === 1;
}
