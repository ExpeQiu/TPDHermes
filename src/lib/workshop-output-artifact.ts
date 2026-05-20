/** 工坊执行结果产出物：格式识别与下载 */

export type WorkshopOutputFormat = "markdown" | "pdf" | "html" | "json" | "plain";

const FORMAT_LABELS: Record<WorkshopOutputFormat, string> = {
  markdown: "Markdown",
  pdf: "PDF",
  html: "HTML",
  json: "JSON",
  plain: "纯文本",
};

export function workshopOutputFormatLabel(format: WorkshopOutputFormat): string {
  return FORMAT_LABELS[format] ?? format;
}

export function normalizeWorkshopOutputFormat(raw: unknown): WorkshopOutputFormat {
  const s = String(raw ?? "markdown")
    .trim()
    .toLowerCase();
  if (s === "pdf" || s.includes("pdf")) return "pdf";
  if (s === "html" || s === "htm") return "html";
  if (s === "json") return "json";
  if (s === "plain" || s === "text" || s === "txt") return "plain";
  return "markdown";
}

export function formatFromOutputPolicy(policy: Record<string, unknown> | undefined): WorkshopOutputFormat {
  if (!policy || typeof policy !== "object") return "markdown";
  const fmt = policy.format;
  return normalizeWorkshopOutputFormat(fmt);
}

export function downloadFilenameBase(title?: string | null): string {
  const t = (title ?? "workshop-output").trim() || "workshop-output";
  return t.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80);
}

export function fileExtensionForFormat(format: WorkshopOutputFormat): string {
  switch (format) {
    case "pdf":
      return "pdf";
    case "html":
      return "html";
    case "json":
      return "json";
    case "plain":
      return "txt";
    default:
      return "md";
  }
}

export function mimeTypeForFormat(format: WorkshopOutputFormat): string {
  switch (format) {
    case "pdf":
      return "application/pdf";
    case "html":
      return "text/html;charset=utf-8";
    case "json":
      return "application/json;charset=utf-8";
    case "plain":
      return "text/plain;charset=utf-8";
    default:
      return "text/markdown;charset=utf-8";
  }
}

export function triggerWorkshopOutputDownload(
  content: string,
  format: WorkshopOutputFormat,
  title?: string | null,
): void {
  if (!content.trim()) return;
  const ext = fileExtensionForFormat(format);
  const mime = mimeTypeForFormat(format);
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${downloadFilenameBase(title)}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function isLikelyPdfBinary(content: string): boolean {
  return content.trimStart().startsWith("%PDF");
}

export function thumbnailPreviewText(content: string, maxLen = 1200): string {
  if (!content) return "";
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

export type WorkshopOutputArtifact = {
  id: string;
  title?: string | null;
  format: WorkshopOutputFormat;
  content: string;
};

/** 从单次执行结果拆出可展示的产出物（如 JSON 包 + 内嵌 Markdown 正文） */
export function deriveWorkshopArtifacts(
  content: string,
  primaryFormat: WorkshopOutputFormat,
  title?: string | null,
): WorkshopOutputArtifact[] {
  const baseTitle = downloadFilenameBase(title);
  if (!content.trim()) return [];

  const primary: WorkshopOutputArtifact = {
    id: "primary",
    title: baseTitle,
    format: primaryFormat,
    content,
  };

  if (primaryFormat !== "json") return [primary];

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const embedded = parsed.content;
    if (typeof embedded === "string" && embedded.trim()) {
      const name =
        typeof parsed.tech_name === "string" && parsed.tech_name.trim()
          ? parsed.tech_name.trim()
          : baseTitle;
      return [
        primary,
        {
          id: "embedded-markdown",
          title: `${name} · 正文`,
          format: "markdown",
          content: embedded,
        },
      ];
    }
  } catch {
    // keep single artifact
  }

  return [primary];
}
