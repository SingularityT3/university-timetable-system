/** Typed fetch wrapper for the JSON API (the route handlers in app/api/, same origin). */

import { go } from "./nav";

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

/** Errors are {detail: string} or, for validation errors, {detail: [{msg, loc}]}. */
function detailOf(body: unknown, fallback: string): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d))
    return d.map((e) => (e as { msg?: string }).msg ?? JSON.stringify(e)).join("; ");
  return fallback;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/login") && typeof window !== "undefined") {
      go("/login");
    }
    throw new ApiError(res.status, detailOf(body, `${res.status} ${res.statusText}`));
  }
  return body as T;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Build "path?a=1&b=2", skipping null/undefined/"" values. */
export function qs(path: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
