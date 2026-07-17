/**
 * 将圆桌 delivery_markdown 拆成「元信息 + 逐条发言」，便于 UI 分条渲染。
 *
 * 引擎约定格式（见 TPD-multi-agent modes）：
 * - 标题 / **议题** / **讨论模式**
 * - ### 开场（主持人）…
 * - **专家名**（R1）：正文  或  **专家名（正方）**（R1）：正文
 * - **升维冲突**：… / **共识检测**：…
 * - ## 综合方案
 */

export type BrainstormTurnKind =
  | "opening"
  | "speech"
  | "escalate"
  | "consensus"
  | "synthesis"
  | "other";

export type BrainstormTurn = {
  id: string;
  kind: BrainstormTurnKind;
  /** 展示名：专家 / 主持人 / 升维冲突 等 */
  speaker: string;
  /** 如 R1、正方 */
  badge?: string;
  content: string;
};

export type ParsedBrainstormDelivery = {
  title: string;
  topic?: string;
  discussionMode?: string;
  preamble: string;
  turns: BrainstormTurn[];
};

const SPEECH_RE =
  /^\*\*(.+?)(?:（([^）]+)）)?\*\*（R(\d+)）[：:]\s*([\s\S]*)$/;
const SPECIAL_LINE_RE = /^\*\*(升维冲突|共识检测)\*\*[：:]\s*([\s\S]*)$/;
const OPENING_RE = /^###\s*开场（([^）]+)）\s*$/;
const SYNTHESIS_RE = /^##\s*综合方案\s*$/;
const META_TOPIC_RE = /^\*\*议题\*\*[：:]\s*(.+)$/;
const META_MODE_RE = /^\*\*讨论模式\*\*[：:]\s*(.+)$/;
const TITLE_RE = /^#\s+(.+)$/;

function pushTurn(
  turns: BrainstormTurn[],
  partial: Omit<BrainstormTurn, "id">,
): void {
  turns.push({ ...partial, id: `turn-${turns.length + 1}` });
}

function flushBuffer(
  turns: BrainstormTurn[],
  buffer: string[],
  fallbackSpeaker = "圆桌",
): void {
  const content = buffer.join("\n").trim();
  if (!content) return;
  pushTurn(turns, {
    kind: "other",
    speaker: fallbackSpeaker,
    content,
  });
  buffer.length = 0;
}

/**
 * 解析 delivery markdown；无法识别结构时回退为单条全文。
 */
export function parseBrainstormDelivery(
  markdown: string,
): ParsedBrainstormDelivery {
  const raw = (markdown || "").trim();
  if (!raw) {
    return { title: "", preamble: "", turns: [] };
  }

  const lines = raw.split(/\r?\n/);
  let title = "";
  let topic: string | undefined;
  let discussionMode: string | undefined;
  const preambleLines: string[] = [];
  const turns: BrainstormTurn[] = [];
  let i = 0;

  // 跳过开头元信息
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    const titleMatch = trimmed.match(TITLE_RE);
    if (titleMatch && !title) {
      title = titleMatch[1]?.trim() || "";
      i += 1;
      continue;
    }
    const topicMatch = trimmed.match(META_TOPIC_RE);
    if (topicMatch) {
      topic = topicMatch[1]?.trim();
      i += 1;
      continue;
    }
    const modeMatch = trimmed.match(META_MODE_RE);
    if (modeMatch) {
      discussionMode = modeMatch[1]?.trim();
      i += 1;
      continue;
    }
    // 遇到开场 / 发言 / 综合方案则进入正文解析
    if (
      OPENING_RE.test(trimmed) ||
      SPEECH_RE.test(trimmed) ||
      SPECIAL_LINE_RE.test(trimmed) ||
      SYNTHESIS_RE.test(trimmed)
    ) {
      break;
    }
    preambleLines.push(line);
    i += 1;
  }

  const buffer: string[] = [];
  let current: Omit<BrainstormTurn, "id"> | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const content = current.content.trim();
    if (content) {
      pushTurn(turns, { ...current, content });
    }
    current = null;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const openingMatch = trimmed.match(OPENING_RE);
    if (openingMatch) {
      commitCurrent();
      flushBuffer(turns, buffer);
      current = {
        kind: "opening",
        speaker: openingMatch[1]?.trim() || "主持人",
        badge: "开场",
        content: "",
      };
      i += 1;
      continue;
    }

    if (SYNTHESIS_RE.test(trimmed)) {
      commitCurrent();
      flushBuffer(turns, buffer);
      current = {
        kind: "synthesis",
        speaker: "主持人",
        badge: "综合方案",
        content: "",
      };
      i += 1;
      continue;
    }

    const specialMatch = trimmed.match(SPECIAL_LINE_RE);
    if (specialMatch) {
      commitCurrent();
      flushBuffer(turns, buffer);
      const label = specialMatch[1] || "";
      current = {
        kind: label === "升维冲突" ? "escalate" : "consensus",
        speaker: label === "升维冲突" ? "主持人" : "共识检测",
        badge: label,
        content: specialMatch[2] || "",
      };
      i += 1;
      continue;
    }

    const speechMatch = trimmed.match(SPEECH_RE);
    if (speechMatch) {
      commitCurrent();
      flushBuffer(turns, buffer);
      const name = speechMatch[1]?.trim() || "专家";
      const stance = speechMatch[2]?.trim();
      const round = speechMatch[3];
      const badges = [`R${round}`, stance].filter(Boolean).join(" · ");
      current = {
        kind: "speech",
        speaker: name,
        badge: badges || undefined,
        content: speechMatch[4] || "",
      };
      i += 1;
      continue;
    }

    if (current) {
      current.content = current.content
        ? `${current.content}\n${line}`
        : line;
    } else {
      buffer.push(line);
    }
    i += 1;
  }

  commitCurrent();
  flushBuffer(turns, buffer);

  if (turns.length === 0) {
    pushTurn(turns, {
      kind: "other",
      speaker: "交付",
      content: raw,
    });
  }

  return {
    title,
    topic,
    discussionMode,
    preamble: preambleLines.join("\n").trim(),
    turns,
  };
}
