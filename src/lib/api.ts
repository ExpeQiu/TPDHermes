import { mergeApiHeadersAsync } from "./api-headers";

/** 后端 API v1 前缀（与 FastAPI `backend/__init__.py` 一致） */
export const API_V1 = "/api/v1";

export function getPublicApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  return raw.replace(/\/$/, "");
}

/** 拼接业务 API 绝对地址，例如 `apiV1("/projects/")` */
export function apiV1(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${getPublicApiBase()}${API_V1}${p}`;
}

export function formatApiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg?: unknown }).msg ?? "");
          }
          return JSON.stringify(item);
        })
        .filter(Boolean)
        .join("；");
    }
  } catch {
    /* 非 JSON 响应 */
  }
  return `HTTP ${status}: ${body.slice(0, 200)}`;
}

export async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatApiError(res.status, t));
  }
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(apiV1(path), await mergeApiHeadersAsync());
  return readJson<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(
    apiV1(path),
    await mergeApiHeadersAsync({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return readJson<T>(res);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(
    apiV1(path),
    await mergeApiHeadersAsync({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return readJson<T>(res);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(
    apiV1(path),
    await mergeApiHeadersAsync({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return readJson<T>(res);
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(apiV1(path), await mergeApiHeadersAsync({ method: "DELETE" }));
  return readJson<T>(res);
}

export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(apiV1(path), await mergeApiHeadersAsync(init));
}

/** 根路径 `/health` 返回 `{ code, data, ... }` 时使用 */
export function unwrapRootHealth<T>(body: unknown): T {
  if (
    body &&
    typeof body === "object" &&
    "data" in body &&
    (body as { code?: number }).code === 0
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}
