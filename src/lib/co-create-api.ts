import { apiGet, apiPost } from "@/lib/api";
import type { ProjectFileKind } from "@/lib/chat-context";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";

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
    content: string;
    target_file_id?: string;
    target_kind?: ProjectFileKind;
    save_mode?: "overwrite" | "new_version" | "copy";
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
