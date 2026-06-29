/**
 * 同源 API 代理：正确透传 SSE 流式响应（比 next.config rewrites 更可靠）。
 */
import type { NextRequest } from "next/server";

const BACKEND = (
  process.env.API_PROXY_URL ??
  process.env.BACKEND_INTERNAL_URL ??
  "http://127.0.0.1:8000"
).replace(/\/$/, "");

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxyRequest(request: NextRequest, pathSegments: string[]) {
  const suffix = pathSegments.join("/");
  const target = `${BACKEND}/api/v1/${suffix}${request.nextUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function handle(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyRequest(request, path);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}

export async function OPTIONS(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
