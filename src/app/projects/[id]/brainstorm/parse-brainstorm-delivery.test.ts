import { describe, expect, it } from "vitest";
import { parseBrainstormDelivery } from "./parse-brainstorm-delivery";

const SAMPLE = `# 圆桌 Master Plan

**议题**：半固态电池怎么对外讲

**讨论模式**：round_robin

### 开场（主持人）
议题：半固态电池怎么对外讲
请各位给出最核心破局建议。

**通俗化大师**（R1）：先讲生活场景：续航焦虑消失的那一刻。

**技术原教旨主义者**（R1）：能量密度与热失控边界必须可验证。

**流量狙击手（正方）**（R1）：钩子是「比液态更安全」的反差。

**升维冲突**：如何在吸引眼球的同时保持高端信仰？

## 综合方案

Slogan：可靠看得见。
三步：测、证、讲。
`;

describe("parseBrainstormDelivery", () => {
  it("拆出议题与各 agent 发言", () => {
    const parsed = parseBrainstormDelivery(SAMPLE);
    expect(parsed.title).toBe("圆桌 Master Plan");
    expect(parsed.topic).toContain("半固态电池");
    expect(parsed.discussionMode).toBe("round_robin");
    expect(parsed.turns.map((t) => t.kind)).toEqual([
      "opening",
      "speech",
      "speech",
      "speech",
      "escalate",
      "synthesis",
    ]);
    expect(parsed.turns[1]?.speaker).toBe("通俗化大师");
    expect(parsed.turns[1]?.badge).toBe("R1");
    expect(parsed.turns[1]?.content).toContain("续航焦虑");
    expect(parsed.turns[3]?.speaker).toBe("流量狙击手");
    expect(parsed.turns[3]?.badge).toContain("正方");
    expect(parsed.turns[5]?.badge).toBe("综合方案");
    expect(parsed.turns[5]?.content).toContain("Slogan");
  });

  it("无法识别时回退为单条全文", () => {
    const parsed = parseBrainstormDelivery("纯文本交付无结构");
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.content).toBe("纯文本交付无结构");
  });
});
