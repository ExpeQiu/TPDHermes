import { describe, expect, it } from "vitest";

import {
  accessibleWorkflowPages,
  groupWorkflowNavEntries,
  isCoCreateNavPath,
  resolveTechIpNavHref,
  WORKFLOW_NAV_ITEMS,
} from "./workflow-nav";

const editorFeatures = [
  "create",
  "knowledge",
  "skills",
  "projects",
  "chat",
  "workshop",
  "settings",
];

describe("groupWorkflowNavEntries", () => {
  it("folds co-create, brainstorm and chat into one content center", () => {
    const entries = groupWorkflowNavEntries(WORKFLOW_NAV_ITEMS);
    const labels = entries.map((entry) => (entry.kind === "group" ? entry.label : entry.item.label));
    expect(labels).toContain("内容创作中心");
    expect(labels).not.toContain("项目共创");
    expect(labels).not.toContain("头脑风暴");
    expect(labels).not.toContain("对话创作");
    const group = entries.find((entry) => entry.kind === "group");
    expect(group?.kind === "group" ? group.items.map((item) => item.label) : []).toEqual([
      "项目共创",
      "头脑风暴",
      "对话创作",
    ]);
    const centerIndex = labels.indexOf("内容创作中心");
    expect(labels[centerIndex - 1]).toBe("快捷创作");
    expect(labels[centerIndex - 2]).toBe("项目中心");
  });
});

describe("quick create nav", () => {
  it("opens the promotion page so the user can pick a project", () => {
    window.history.pushState({}, "", "/projects");
    window.localStorage.clear();
    expect(resolveTechIpNavHref("user-1")).toBe("/promotion");
  });
});

describe("co-create nav", () => {
  it("points the menu at /co-create instead of the project center", () => {
    const item = WORKFLOW_NAV_ITEMS.find((entry) => entry.label === "项目共创");
    expect(item?.href).toBe("/co-create");
    expect(isCoCreateNavPath("/co-create")).toBe(true);
    expect(isCoCreateNavPath("/projects/p1/co-create")).toBe(true);
  });
});

describe("accessibleWorkflowPages", () => {
  it("hides admin entries until access is known", () => {
    const labels = accessibleWorkflowPages(null).map((page) => page.label);
    expect(labels).toContain("工作台首页");
    expect(labels).not.toContain("配置");
    expect(labels).not.toContain("场景输出");
    expect(labels).not.toContain("场景编排");
    expect(labels).not.toContain("知识库");
    expect(labels).not.toContain("迭代成长");
  });

  it("hides workshop, create, knowledge and settings from project admins", () => {
    const labels = accessibleWorkflowPages({
      features: editorFeatures,
      platformRole: "tenant_editor",
    }).map((page) => page.label);
    expect(labels).toEqual(
      expect.arrayContaining(["工作台首页", "项目中心", "快捷创作", "头脑风暴", "对话创作", "媒体工作台", "技能工坊"]),
    );
    expect(labels).not.toContain("场景输出");
    expect(labels).not.toContain("场景编排");
    expect(labels).not.toContain("知识库");
    expect(labels).not.toContain("配置");
    expect(labels).not.toContain("迭代成长");
  });

  it("shows those entries to system admins", () => {
    const labels = accessibleWorkflowPages({
      features: [...editorFeatures, "ops"],
      platformRole: "tenant_admin",
    }).map((page) => page.label);
    expect(labels).toEqual(expect.arrayContaining(["知识库", "配置", "迭代成长"]));
    expect(labels).not.toContain("场景输出");
    expect(labels).not.toContain("场景编排");
  });

  it("keeps partner pages to the public set", () => {
    const labels = accessibleWorkflowPages({
      features: ["projects", "chat", "workshop", "skills", "settings"],
      platformRole: "tenant_partner",
    }).map((page) => page.label);
    expect(labels).toEqual([
      "工作台首页",
      "项目中心",
      "快捷创作",
      "项目共创",
      "头脑风暴",
      "对话创作",
      "媒体工作台",
      "技能工坊",
    ]);
  });
});
