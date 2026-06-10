"use client";

import { useMemo } from "react";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  isLikelyPdfBinary,
  normalizeWorkshopOutputFormat,
  type WorkshopOutputFormat,
} from "@/lib/workshop-output-artifact";

function inferOutputFormat(content: string, explicit?: string | null): WorkshopOutputFormat {
  if (explicit) return normalizeWorkshopOutputFormat(explicit);
  if (isLikelyPdfBinary(content)) return "pdf";
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    /^<\w+[\s>]/.test(trimmed)
  ) {
    return "html";
  }
  return "markdown";
}

function structuredSectionsToMarkdown(
  sections: Record<string, unknown>,
  root: Record<string, unknown>,
): string {
  const lines: string[] = [];
  const title = String(sections.tech_name ?? root.tech_name ?? "").trim();
  if (title) lines.push(`# ${title}`);

  const slogan = String(sections.slogan ?? "").trim();
  if (slogan) lines.push(`> ${slogan}`);

  const sceneBenefits = sections.scene_benefits;
  if (Array.isArray(sceneBenefits) && sceneBenefits.length > 0) {
    lines.push("## 场景收益");
    for (const item of sceneBenefits) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      lines.push(`- ${String(row.scene ?? "")}：${String(row.benefit ?? "")}`);
    }
  }

  const highlights = sections.tech_highlights;
  if (Array.isArray(highlights) && highlights.length > 0) {
    lines.push("## 技术亮点");
    for (const item of highlights) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      lines.push(
        `- **${String(row.highlight ?? "")}**：${String(row.params ?? "")} → ${String(row.user_benefit ?? "")}`,
      );
    }
  }

  const testData = sections.test_data;
  if (Array.isArray(testData) && testData.length > 0) {
    lines.push("## 实测数据");
    for (const item of testData) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      lines.push(`- **${String(row.data ?? "")}**（${String(row.source ?? "")}）`);
    }
  }

  const vehicles = sections.vehicle_models;
  if (Array.isArray(vehicles) && vehicles.length > 0) {
    lines.push("## 搭载车型 & 权益");
    lines.push("| 车型 | 方案 | 核心权益 |");
    lines.push("| --- | --- | --- |");
    for (const item of vehicles) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      lines.push(
        `| ${String(row.model ?? "")} | ${String(row.plan ?? "")} | ${String(row.rights ?? "")} |`,
      );
    }
  }

  return lines.join("\n\n");
}

function jsonToRenderableMarkdown(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }
    const sections = parsed.sections;
    if (sections && typeof sections === "object" && !Array.isArray(sections)) {
      const md = structuredSectionsToMarkdown(sections as Record<string, unknown>, parsed);
      if (md.trim()) return md;
    }
  } catch {
    // fall through
  }
  return null;
}

export function ProjectOutputContentBody({
  content,
  contentFormat,
  loading,
}: {
  content: string | null;
  contentFormat?: string | null;
  loading?: boolean;
}) {
  const rendered = useMemo(() => {
    if (loading) return { kind: "loading" as const };
    const text = (content ?? "").trim();
    if (!text) return { kind: "empty" as const };

    const jsonMarkdown = text.startsWith("{") || text.startsWith("[") ? jsonToRenderableMarkdown(text) : null;
    if (jsonMarkdown) {
      return { kind: "markdown" as const, text: jsonMarkdown };
    }

    const format = inferOutputFormat(text, contentFormat);
    if (format === "pdf" || isLikelyPdfBinary(text)) {
      return { kind: "message" as const, text: "当前内容为 PDF 二进制流，请下载后使用 PDF 阅读器打开。" };
    }
    if (format === "html") {
      return { kind: "html" as const, text };
    }
    if (format === "json") {
      try {
        return { kind: "pre" as const, text: JSON.stringify(JSON.parse(text), null, 2) };
      } catch {
        return { kind: "pre" as const, text };
      }
    }
    return { kind: "markdown" as const, text };
  }, [content, contentFormat, loading]);

  if (rendered.kind === "loading") {
    return <p className="text-sm text-slate-500">正在加载全文…</p>;
  }
  if (rendered.kind === "empty") {
    return <p className="text-sm text-slate-500">暂无内容</p>;
  }
  if (rendered.kind === "message") {
    return <p className="text-sm text-slate-500">{rendered.text}</p>;
  }
  if (rendered.kind === "html") {
    return (
      <div
        className="prose prose-sm max-w-none text-slate-800 dark:prose-invert dark:text-slate-200"
        dangerouslySetInnerHTML={{ __html: rendered.text }}
      />
    );
  }
  if (rendered.kind === "pre") {
    return (
      <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-slate-800 dark:text-slate-200">
        {rendered.text}
      </pre>
    );
  }
  return <ChatMarkdownBody content={rendered.text} />;
}
