/**
 * Calls the route handlers in app/api/** directly (no server), keeping cookies between calls
 * like a browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PROJECT_ROOT } from "@/lib/server/env";

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

/** app/api/<path>/route.ts for a URL path, plus the dynamic segment values. */
function resolve(pathname: string): { file: string; params: Record<string, string | string[]> } {
  let dir = join(PROJECT_ROOT, "app", "api");
  const params: Record<string, string | string[]> = {};
  const segs = pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    if (existsSync(join(dir, segs[i]))) {
      dir = join(dir, segs[i]);
      continue;
    }
    const dyn = readdirSync(dir).find((d) => /^\[[^.]+\]$/.test(d));
    if (dyn) {
      params[dyn.slice(1, -1)] = segs[i];
      dir = join(dir, dyn);
      continue;
    }
    params.path = segs.slice(i);
    dir = join(PROJECT_ROOT, "app", "api", "[...path]");
    break;
  }
  return { file: join(dir, "route.ts"), params };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON of any shape
}

export class Client {
  readonly cookies = new Map<string, string>();

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const url = new URL(`/api${path}`, "http://localhost");
    const { file, params } = resolve(url.pathname);
    const handler = ((await import(file)) as Record<string, Handler>)[method];
    if (!handler) throw new Error(`no ${method} handler in ${file}`);
    const headers = new Headers();
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (body !== undefined) headers.set("content-type", "application/json");
    const req = new NextRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handler(req, { params: Promise.resolve(params) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (/max-age=0/i.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  get = (path: string) => this.request("GET", path);
  post = (path: string, body?: unknown) => this.request("POST", path, body);
  put = (path: string, body?: unknown) => this.request("PUT", path, body);
  delete = (path: string) => this.request("DELETE", path);
}

/** A client logged in as `username`. */
export async function login(username: string, password: string): Promise<Client> {
  const c = new Client();
  const r = await c.post("/auth/login", { username, password });
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}
