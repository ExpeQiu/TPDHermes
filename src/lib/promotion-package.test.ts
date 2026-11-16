import { describe, expect, it } from "vitest";

import {
  approvalsAfterFactChange,
  blockedProductIds,
  exportConflicts,
  structuredHighAccuracyRows,
} from "./promotion-package";

describe("promotion package rules", () => {
  it("shows missing, conflict and unreadable without blocking on parse failure", () => {
    const blocked = blockedProductIds([
      { key: "comparison", status: "missing", blocks: ["interview_qa_skill"] },
      { key: "quantified_data", status: "conflict", blocks: ["a4_skill", "tech_pr_skill"] },
      { key: "parse", status: "unreadable", blocks: [] },
    ]);
    expect(blocked).toEqual(["a4_skill", "interview_qa_skill", "tech_pr_skill"]);
  });

  it("keeps unrelated approvals when another fact changes", () => {
    const next = approvalsAfterFactChange(
      [
        { product: "a4_skill", status: "approved", factIds: ["fact_metric"] },
        { product: "tech_pr_skill", status: "approved", factIds: ["fact_metric"] },
        { product: "interview_qa_skill", status: "approved", factIds: ["fact_compare"] },
      ],
      ["fact_metric"],
    );
    expect(next.map((item) => item.status)).toEqual([
      "needs_rereview",
      "needs_rereview",
      "approved",
    ]);
  });

  it("keeps measured table rows and drops placeholders", () => {
    const rows = structuredHighAccuracyRows(`
| 指标 | 数值 | 口径 |
|---|---|---|
| 发动机热效率 | **48.41%** | 中汽中心认证 |
| 媒体联络 | 待补充 |  |
`);
    expect(rows).toEqual([
      { metric: "发动机热效率", value: "48.41%", condition: "中汽中心认证", source: "" },
    ]);
  });

  it("rejects a stale or unapproved export selection", () => {
    expect(
      exportConflicts([
        { id: "a4", status: "approved", stale: true },
        { id: "qa", status: "draft", stale: false },
      ]),
    ).toEqual([
      { id: "a4", reason: "facts_changed" },
      { id: "qa", reason: "not_approved" },
    ]);
  });
});
