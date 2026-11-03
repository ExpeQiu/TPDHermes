/** V04 技术卡状态与本地回退。正常路径由 /api/v1/studio/turn 驱动。 */

export const STUDIO_PRODUCT = "V04";

export const SOURCE_TEXT = [
  "800V 高压平台将直流母线电压提升至 800 伏，用于降低线束电流。样本未给出持续功率。",
  "碳化硅功率模块用 SiC MOSFET 替换硅基器件，开关频率更高。文中未写适用车型。",
  "SiC 逆变器与碳化硅功率模块描述同一动力域部件，开关动作相同。",
  "座舱氛围灯属于座舱域，调节内饰颜色，与电驱参数无共同定义。",
].join("\n");

export type FieldKey = "definition" | "principle" | "parameter" | "scope";

export const FIELD_LABEL: Record<FieldKey, string> = {
  definition: "定义",
  principle: "原理",
  parameter: "参数",
  scope: "适用范围",
};

export type TechCard = {
  id: string;
  term: string;
  aliases: string[];
  domain: string;
  definition: string;
  principle: string;
  parameter: string;
  scope: string;
  quotes: Record<FieldKey, string>;
  status: "candidate" | "locked";
};

export type StudioState = {
  revision: number;
  nextId: number;
  cards: TechCard[];
  selectedCardId: string | null;
  selectedField: FieldKey | null;
  lastOperation: string | null;
  lastRunId: string | null;
  blockedReason: string | null;
};

export type StudioLog = {
  event: "studio.operation";
  operation: string;
  run_id: string;
  revision: number;
  card_count: number;
  locked_ids: string[];
  ok: boolean;
};

export type StudioResult = {
  state: StudioState;
  reply: string;
  log: StudioLog;
};

type CardDraft = Omit<TechCard, "id" | "status">;

const CATALOG: CardDraft[] = [
  {
    term: "800V 高压平台",
    aliases: ["800V"],
    domain: "动力",
    definition: "将直流母线电压提升至 800 伏",
    principle: "降低线束电流",
    parameter: "800 伏",
    scope: "",
    quotes: {
      definition: "800V 高压平台将直流母线电压提升至 800 伏",
      principle: "用于降低线束电流",
      parameter: "提升至 800 伏",
      scope: "样本未给出持续功率",
    },
  },
  {
    term: "碳化硅功率模块",
    aliases: ["碳化硅"],
    domain: "动力",
    definition: "用 SiC MOSFET 替换硅基器件",
    principle: "开关频率更高",
    parameter: "",
    scope: "",
    quotes: {
      definition: "碳化硅功率模块用 SiC MOSFET 替换硅基器件",
      principle: "开关频率更高",
      parameter: "",
      scope: "文中未写适用车型",
    },
  },
  {
    term: "SiC 逆变器",
    aliases: ["逆变器"],
    domain: "动力",
    definition: "与碳化硅功率模块描述同一动力域部件",
    principle: "开关动作相同",
    parameter: "",
    scope: "",
    quotes: {
      definition: "SiC 逆变器与碳化硅功率模块描述同一动力域部件",
      principle: "开关动作相同",
      parameter: "",
      scope: "",
    },
  },
  {
    term: "座舱氛围灯",
    aliases: ["氛围灯", "座舱"],
    domain: "座舱",
    definition: "调节内饰颜色",
    principle: "",
    parameter: "",
    scope: "座舱域",
    quotes: {
      definition: "调节内饰颜色",
      principle: "",
      parameter: "",
      scope: "座舱氛围灯属于座舱域",
    },
  },
];

const MERGE_TERMS = new Set(["碳化硅功率模块", "SiC 逆变器"]);

export function createStudioState(): StudioState {
  return {
    revision: 0,
    nextId: 1,
    cards: [],
    selectedCardId: null,
    selectedField: null,
    lastOperation: null,
    lastRunId: null,
    blockedReason: null,
  };
}

export function quoteFor(card: TechCard, field: FieldKey): string {
  return card.quotes[field] || card.quotes.definition;
}

export function emptyFields(card: TechCard): FieldKey[] {
  return (Object.keys(FIELD_LABEL) as FieldKey[]).filter((field) => !card[field].trim());
}

function lockedIds(cards: TechCard[]): string[] {
  return cards.filter((card) => card.status === "locked").map((card) => card.id);
}

function finish(
  prev: StudioState,
  next: Omit<StudioState, "lastOperation" | "lastRunId">,
  operation: string,
  reply: string,
  ok: boolean,
): StudioResult {
  const runId = `studio_${operation}_${next.revision}`;
  const state: StudioState = { ...next, lastOperation: operation, lastRunId: runId };
  return {
    state,
    reply,
    log: {
      event: "studio.operation",
      operation,
      run_id: runId,
      revision: state.revision,
      card_count: state.cards.length,
      locked_ids: lockedIds(state.cards),
      ok,
    },
  };
}

function materialize(draft: CardDraft, id: string): TechCard {
  return { ...draft, aliases: [...draft.aliases], quotes: { ...draft.quotes }, id, status: "candidate" };
}

function covers(locked: TechCard[], draft: CardDraft): boolean {
  const names = new Set(locked.flatMap((card) => [card.term, ...card.aliases]));
  return names.has(draft.term) || draft.aliases.some((alias) => names.has(alias));
}

function extract(prev: StudioState): StudioResult {
  const locked = prev.cards.filter((card) => card.status === "locked");
  let nextId = prev.nextId;
  const fresh = CATALOG.filter((draft) => !covers(locked, draft)).map((draft) => {
    const card = materialize(draft, `card_${nextId}`);
    nextId += 1;
    return card;
  });
  const cards = [...locked, ...fresh];
  const selectedStillThere = cards.some((card) => card.id === prev.selectedCardId);
  return finish(
    prev,
    {
      revision: prev.revision + 1,
      nextId,
      cards,
      selectedCardId: selectedStillThere ? prev.selectedCardId : cards[0]?.id ?? null,
      selectedField: selectedStillThere ? prev.selectedField : "definition",
      blockedReason: null,
    },
    "extract",
    `已提取 ${fresh.length} 张候选。已锁定 ${locked.length} 张保持原内容。空字段保留为缺口，没有补写事实。`,
    true,
  );
}

function lockSelected(prev: StudioState): StudioResult {
  const card = prev.cards.find((item) => item.id === prev.selectedCardId);
  if (!card) {
    return finish(prev, prev, "lock", "先在右侧点一张技术卡，再锁定。", false);
  }
  if (card.status === "locked") {
    return finish(prev, prev, "lock", `「${card.term}」已经锁定。`, true);
  }
  const cards = prev.cards.map((item) =>
    item.id === card.id ? { ...item, status: "locked" as const } : item,
  );
  return finish(
    prev,
    { ...prev, revision: prev.revision + 1, cards, blockedReason: null },
    "lock",
    `已锁定「${card.term}」。再次提取不会覆盖这张卡。`,
    true,
  );
}

function sameDomainPair(cards: TechCard[]): TechCard[] {
  return cards.filter((card) => card.domain === "动力" && MERGE_TERMS.has(card.term));
}

function mergeSameDomain(prev: StudioState): StudioResult {
  const pair = sameDomainPair(prev.cards);
  if (pair.length < 2) {
    return finish(prev, prev, "merge", "要合并的同域候选不足两张。先提取技术卡。", false);
  }
  if (pair.some((card) => card.status === "locked")) {
    return finish(
      prev,
      { ...prev, blockedReason: "已锁定卡片不能被合并覆盖" },
      "merge",
      "其中一张已锁定。合并会改写已确认内容，已停下。",
      false,
    );
  }
  const [primary, alias] = pair;
  let nextId = prev.nextId;
  const merged: TechCard = {
    id: `card_${nextId}`,
    term: primary.term,
    aliases: [alias.term, ...primary.aliases, ...alias.aliases],
    domain: "动力",
    definition: `${primary.definition}。同义写法：${alias.term}`,
    principle: primary.principle || alias.principle,
    parameter: primary.parameter,
    scope: "",
    quotes: {
      definition: primary.quotes.definition,
      principle: primary.quotes.principle || alias.quotes.principle,
      parameter: primary.quotes.parameter,
      scope: primary.quotes.scope || alias.quotes.scope,
    },
    status: "candidate",
  };
  nextId += 1;
  const drop = new Set(pair.map((card) => card.id));
  const cards = [merged, ...prev.cards.filter((card) => !drop.has(card.id))];
  return finish(
    prev,
    {
      ...prev,
      revision: prev.revision + 1,
      nextId,
      cards,
      selectedCardId: merged.id,
      selectedField: "definition",
      blockedReason: null,
    },
    "merge",
    `已把「${alias.term}」并入「${primary.term}」。两处原文都还在，适用范围仍空着。`,
    true,
  );
}

function mergeCrossDomain(prev: StudioState): StudioResult {
  return finish(
    prev,
    { ...prev, blockedReason: "跨域卡片不能合并" },
    "merge",
    "座舱氛围灯与动力域技术点不是同一对象，没有合并。",
    false,
  );
}

function locate(prev: StudioState, text: string): StudioResult {
  const card = prev.cards.find((item) => {
    const names = [item.term, ...item.aliases];
    return names.some((name) => text.includes(name));
  });
  if (!card) {
    return finish(prev, prev, "locate", "没有找到对应技术卡。先提取，或点右侧卡片。", false);
  }
  return finish(
    prev,
    { ...prev, selectedCardId: card.id, selectedField: "definition", blockedReason: null },
    "locate",
    `已定位「${card.term}」，右侧原文标出定义出处。`,
    true,
  );
}

function describeGaps(prev: StudioState): StudioResult {
  const lines = prev.cards.flatMap((card) =>
    emptyFields(card).map((field) => `「${card.term}」的${FIELD_LABEL[field]}`),
  );
  if (lines.length === 0) {
    return finish(prev, prev, "gaps", prev.cards.length ? "当前卡片没有空字段。" : "还没有技术卡。", true);
  }
  return finish(prev, prev, "gaps", `这些字段原文没有记载：${lines.join("、")}。`, true);
}

export function parseStudioCommand(text: string): string {
  const raw = text.trim();
  if (!raw) return "help";
  if (/缺口|缺什么|空字段/.test(raw)) return "gaps";
  if (/锁定/.test(raw)) return "lock";
  if (/跨域|氛围灯|座舱/.test(raw) && /合并/.test(raw)) return "merge-cross";
  if (/合并/.test(raw)) return "merge";
  if (/定位|看看|查看/.test(raw)) return "locate";
  if (/提取|重新|再来/.test(raw)) return "extract";
  return "help";
}

export function applyStudioCommand(prev: StudioState, text: string): StudioResult {
  const command = parseStudioCommand(text);
  if (command === "extract") return extract(prev);
  if (command === "lock") return lockSelected(prev);
  if (command === "merge") return mergeSameDomain(prev);
  if (command === "merge-cross") return mergeCrossDomain(prev);
  if (command === "locate") return locate(prev, text);
  if (command === "gaps") return describeGaps(prev);
  return finish(
    prev,
    prev,
    "help",
    "可以说：提取技术卡、查看缺口、锁定、合并同域、合并氛围灯。点右侧字段会标出原文。",
    true,
  );
}

export function selectCardField(prev: StudioState, cardId: string, field: FieldKey): StudioState {
  if (!prev.cards.some((card) => card.id === cardId)) return prev;
  return { ...prev, selectedCardId: cardId, selectedField: field, blockedReason: null };
}
