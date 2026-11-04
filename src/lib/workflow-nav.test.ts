import { describe, expect, it } from "vitest";

import { accessibleWorkflowPages } from "./workflow-nav";

const editorFeatures = [
  "create",
  "knowledge",
  "skills",
  "projects",
  "chat",
  "workshop",
  "settings",
];

describe("accessibleWorkflowPages", () => {
  it("hides admin entries until access is known", () => {
    const labels = accessibleWorkflowPages(null).map((page) => page.label);
    expect(labels).toContain("工作台首页");
    expect(labels).not.toContain("配置");
    expect(labels).not.toContain("场景输出");
    expect(labels).not.toContain("场景编排");
    expect(labels).not.toContain("知识库");
    expect(labels).not.toContain("运维用量");
  });

  it("hides workshop, create, knowledge and settings from project admins", () => {
    const labels = accessibleWorkflowPages({
      features: editorFeatures,
      platformRole: "tenant_editor",
    }).map((page) => page.label);
    expect(labels).toEqual(
      expect.arrayContaining(["工作台首页", "项目中心", "对话创作", "场景创作", "技能工坊"]),
    );
    expect(labels).not.toContain("场景输出");
    expect(labels).not.toContain("场景编排");
    expect(labels).not.toContain("知识库");
    expect(labels).not.toContain("配置");
    expect(labels).not.toContain("运维用量");
  });

  it("shows those entries to system admins", () => {
    const labels = accessibleWorkflowPages({
      features: [...editorFeatures, "ops"],
      platformRole: "tenant_admin",
    }).map((page) => page.label);
    expect(labels).toEqual(
      expect.arrayContaining(["场景输出", "场景编排", "知识库", "配置", "运维用量"]),
    );
  });

  it("keeps partner pages to the public set", () => {
    const labels = accessibleWorkflowPages({
      features: ["projects", "chat", "workshop", "skills", "settings"],
      platformRole: "tenant_partner",
    }).map((page) => page.label);
    expect(labels).toEqual([
      "工作台首页",
      "项目中心",
      "项目共创",
      "对话创作",
      "场景创作",
      "技能工坊",
    ]);
  });
});
