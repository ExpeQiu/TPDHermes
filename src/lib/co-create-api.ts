import { apiFetch, apiGet, apiPatch, apiPost, readJson } from "@/lib/api";
import type { ProjectFileKind } from "@/lib/chat-context";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";
import {
  downloadFilenameBase,
  fileExtensionForFormat,
  mimeTypeForFormat,
  normalizeWorkshopOutputFormat,
} from "@/lib/workshop-output-artifact";

export interface ProjectFileItem {
  id: string;
  kind: ProjectFileKind;
  title: string;
  path: string;
  file_type: string;
  status?: string | null;
  ref_state?: "unselected" | "round" | "pinned" | "ai_suggested" | null;
  updated_at?: string | null;
  summary?: string | null;
  created_at?: string | null;
  /** 创建者 User ID（输出物有；附件当前未落库则为空） */
  owner_id?: string | null;
  version?: string | null;
}

export interface ProjectFileDetail extends ProjectFileItem {
  content: string;
  content_format?: string | null;
}

export interface ProjectFileVersionItem {
  id: string;
  version: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface FileActionApplyRequest {
  session_id?: string | null;
  message_id?: string | null;
  proposal_id: string;
  action: {
    type: "create" | "patch";
    file_name?: string;
    path?: string;
    content?: string;
    target_file_id?: string;
    target_kind?: ProjectFileKind;
    save_mode?: "overwrite" | "new_version" | "copy";
    edit_mode?: "full" | "search_replace" | "line_range";
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    start_line?: number;
    end_line?: number;
    new_text?: string;
    after?: string;
  };
}

export interface FileActionApplyResponse {
  ok: boolean;
  file_id: string;
  kind: ProjectFileKind;
  version?: string | null;
}

export async function fetchProjectFilesUnified(projectId: string): Promise<ProjectFileItem[]> {
  const res = await apiGet<{ items: ProjectFileItem[] }>(`/projects/${projectId}/files`);
  return res.items ?? [];
}

export async function fetchProjectFileDetail(
  projectId: string,
  fileId: string,
  kind: ProjectFileKind,
): Promise<ProjectFileDetail> {
  return apiGet<ProjectFileDetail>(
    `/projects/${projectId}/files/${fileId}?kind=${encodeURIComponent(kind)}`,
  );
}

export async function fetchProjectFileVersions(
  projectId: string,
  fileId: string,
  kind: ProjectFileKind,
): Promise<ProjectFileVersionItem[]> {
  const res = await apiGet<{ items: ProjectFileVersionItem[] }>(
    `/projects/${projectId}/files/${fileId}/versions?kind=${encodeURIComponent(kind)}`,
  );
  return res.items ?? [];
}

export async function applyFileAction(
  projectId: string,
  body: FileActionApplyRequest,
): Promise<FileActionApplyResponse> {
  return apiPost<FileActionApplyResponse>(`/projects/${projectId}/file-actions/apply`, body);
}

export async function archiveProjectOutput(
  projectId: string,
  outputId: string,
): Promise<ProjectFileDetail> {
  return apiPost<ProjectFileDetail>(`/projects/${projectId}/outputs/${outputId}/archive`, {});
}

/** 重命名项目文件（输出物改 title；附件改 original_filename） */
export async function renameProjectFile(
  projectId: string,
  fileId: string,
  kind: ProjectFileKind,
  title: string,
): Promise<{ title: string }> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("文件名不能为空");
  if (kind === "attachment") {
    const updated = await apiPatch<{ original_filename: string }>(
      `/projects/${projectId}/attachments/${fileId}`,
      { original_filename: trimmed },
    );
    console.info("[co-create] 附件已重命名", { projectId, fileId, title: updated.original_filename });
    return { title: updated.original_filename };
  }
  const detail = await fetchProjectFileDetail(projectId, fileId, "output");
  const result = await applyFileAction(projectId, {
    proposal_id: `rename-${Date.now()}`,
    action: {
      type: "patch",
      target_file_id: fileId,
      target_kind: "output",
      content: detail.content ?? "",
      file_name: trimmed,
      save_mode: "overwrite",
    },
  });
  const nextTitle =
    typeof (result as { title?: string }).title === "string"
      ? (result as { title: string }).title
      : trimmed.toLowerCase().endsWith(".md")
        ? trimmed
        : `${trimmed}.md`;
  console.info("[co-create] 输出物已重命名", { projectId, fileId, title: nextTitle });
  return { title: nextTitle };
}

/** 上传项目附件（与项目详情页「上传附件」一致） */
export async function uploadProjectAttachment(
  projectId: string,
  file: File,
  options?: { ocr?: boolean },
): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  const query = options?.ocr ? "?ocr=true" : "";
  const res = await apiFetch(`/projects/${projectId}/attachments${query}`, {
    method: "POST",
    body: fd,
  });
  await readJson(res);
  console.info("[co-create] 项目附件已上传", {
    projectId,
    fileName: file.name,
    size: file.size,
    ocr: Boolean(options?.ocr),
  });
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeDownloadFilename(title: string, fallbackExt: string): string {
  const raw = (title || "document").trim() || "document";
  const safe = raw.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 120);
  if (/\.[a-z0-9]{1,8}$/i.test(safe)) return safe;
  return `${safe}.${fallbackExt.replace(/^\./, "")}`;
}

/** 将项目文件导出并触发浏览器本地下载 */
export async function exportProjectFileToLocal(
  projectId: string,
  file: Pick<ProjectFileItem, "id" | "kind" | "title" | "file_type">,
): Promise<{ filename: string }> {
  if (file.kind === "attachment") {
    const res = await apiFetch(`/projects/${projectId}/attachments/${file.id}/download`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text.slice(0, 200) || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const filename = sanitizeDownloadFilename(file.title, "bin");
    triggerBrowserDownload(blob, filename);
    console.info("[co-create] 附件已导出到本地", { projectId, fileId: file.id, filename });
    return { filename };
  }

  const detail = await fetchProjectFileDetail(projectId, file.id, "output");
  const format = normalizeWorkshopOutputFormat(detail.content_format ?? file.file_type);
  const ext = fileExtensionForFormat(format);
  const mime = mimeTypeForFormat(format);
  const title = detail.title || file.title;
  const filename = `${downloadFilenameBase(title)}.${ext}`;
  const blob = new Blob([detail.content ?? ""], { type: mime });
  triggerBrowserDownload(blob, filename);
  console.info("[co-create] 输出物已导出到本地", {
    projectId,
    fileId: file.id,
    filename,
    contentLen: detail.content?.length ?? 0,
  });
  return { filename };
}

export function parseFileActionsFromContent(content: string): FileActionProposal[] {
  const match = content.match(/```tphermes_file_actions\s*\n([\s\S]*?)```/);
  if (!match?.[1]) return [];
  try {
    const parsed = JSON.parse(match[1].trim()) as { actions?: FileActionProposal[] };
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
  }
}
