/**
 * Shared helpers of the route handlers (app/api/**): JSON responses, login/role checks,
 * request validation and the mapping of errors to status codes:
 *
 *   HttpError                 its own status            {detail: string}
 *   validation (Fields)       422                       {detail: [{type, loc, msg, input}]}
 *   InputError / NotFound     400 / 404                 (Neo4j wrappers)
 *   Neo4j unreachable         503
 *   SubstitutionError         409
 *   MySQL                     403 privilege, 409 unique/FK clash, 503 cannot connect, else 400
 *   anything else             500 "Internal Server Error" (logged)
 */
import { NextResponse, type NextRequest } from "next/server";
import { appSecret, COOKIE, getUser, readToken, type User } from "./auth";
import { InputError, neo4jDownReason, NotFoundError } from "./neo4j";
import { SubstitutionError } from "./generator";
import { describeMysqlError } from "./utils";

export interface Issue { type: string; loc: (string | number)[]; msg: string; input: unknown; ctx?: Record<string, unknown> }

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string | Issue[]) {
    super(typeof detail === "string" ? detail : "validation error");
  }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

// ------------------------------------------------------------- errors
const MYSQL_DENIED = new Set([1044, 1142, 1143, 1370]); // privilege missing for this SQL role
const MYSQL_CLASH = new Set([1062, 1451, 1452]); // unique / foreign-key clash
const MYSQL_DOWN = new Set([1045, 2003, 2005, 2013]); // cannot log in / reach the server
const NET_DOWN = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"]);

export const neo4jDownDetail = (reason: string) =>
  `Neo4j is not reachable (${reason}). Start it (docker compose up -d), check \`npm run queries -- check\`, then try again.`;

/** Status and detail for an error, or null when it is not one the API explains. */
export function describeError(e: unknown): { status: number; detail: string | Issue[] } | null {
  if (e instanceof HttpError) return { status: e.status, detail: e.detail };
  if (e instanceof SubstitutionError) return { status: 409, detail: e.message };
  if (e instanceof InputError) return { status: 400, detail: e.message };
  if (e instanceof NotFoundError) return { status: 404, detail: e.message };
  const down = neo4jDownReason(e);
  if (down) return { status: 503, detail: neo4jDownDetail(down) };
  const m = e as { errno?: number; code?: string; sqlMessage?: string };
  if (m && (m.sqlMessage !== undefined || NET_DOWN.has(m.code ?? ""))) {
    const errno = m.errno ?? 0;
    const status = MYSQL_DENIED.has(errno) ? 403 : MYSQL_CLASH.has(errno) ? 409
      : MYSQL_DOWN.has(errno) || NET_DOWN.has(m.code ?? "") ? 503 : 400;
    return { status, detail: describeMysqlError(e) };
  }
  return null;
}

export function errorResponse(e: unknown): NextResponse {
  const known = describeError(e);
  if (known) return json({ detail: known.detail }, known.status);
  console.error(e);
  return json({ detail: "Internal Server Error" }, 500);
}

// ---------------------------------------------------------- auth
/** The logged-in user (401 when the cookie is missing, invalid, expired or the user inactive). */
export async function requireUser(req: NextRequest): Promise<User> {
  const payload = readToken(req.cookies.get(COOKIE)?.value, appSecret());
  const user = payload ? await getUser(payload.uid) : null;
  if (!user) throw new HttpError(401, "Not logged in, or the session has expired.");
  return user;
}

export interface Ctx<P> { req: NextRequest; user: User; params: P; query: Fields }

/**
 * A route handler that needs a login (and the admin role with `admin: true`); the result is
 * sent as JSON (or as is when it is already a Response), errors as described above.
 */
export function route<P = Record<string, never>>(
  fn: (ctx: Ctx<P>) => Promise<unknown>,
  opts: { admin?: boolean } = {},
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<Response> => {
    try {
      const user = await requireUser(req);
      if (opts.admin && user.role !== "admin") throw new HttpError(403, "Only an admin can do this.");
      const query = new Fields(Object.fromEntries(req.nextUrl.searchParams), ["query"]);
      const out = await fn({ req, user, params: await segment.params, query });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

// ---------------------------------------------------------- validation
type Num = { default?: number; ge?: number; le?: number };

/**
 * Reads and validates fields with lenient coercion (numeric strings, booleans): problems are
 * collected and check() throws one 422 listing them all. A field with a problem reads as a placeholder
 * value, so always call check() before using the values.
 */
export class Fields {
  readonly issues: Issue[];
  constructor(private readonly data: Record<string, unknown>, private readonly loc: (string | number)[], issues: Issue[] = []) {
    this.issues = issues;
  }

  /** Parse a JSON request body (422 when missing, malformed or not an object). */
  static async body(req: Request): Promise<Fields> {
    const text = await req.text();
    const bad = (type: string, msg: string, input: unknown = null): never => {
      throw new HttpError(422, [{ type, loc: ["body"], msg, input }]);
    };
    if (!text.trim()) bad("missing", "Field required");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      bad("json_invalid", "JSON decode error", {});
    }
    if (typeof data !== "object" || data === null || Array.isArray(data))
      bad("model_attributes_type", "Input should be a valid dictionary or object to extract fields from", data);
    return new Fields(data as Record<string, unknown>, ["body"]);
  }

  private issue(name: string, type: string, msg: string, input: unknown, ctx?: Record<string, unknown>): void {
    this.issues.push({ type, loc: [...this.loc, name], msg, input, ...(ctx && { ctx }) });
  }

  /** The raw value; undefined (after recording "missing" when required) when absent. */
  private raw(name: string, required: boolean, nullable: boolean): unknown {
    const v = this.data[name];
    if (v === undefined) {
      if (required) this.issue(name, "missing", "Field required", this.loc[0] === "body" ? this.data : null);
      return undefined;
    }
    return v === null && nullable ? undefined : v;
  }

  private range(name: string, n: number, input: unknown, { ge, le }: Num): number {
    if (ge !== undefined && n < ge) this.issue(name, "greater_than_equal", `Input should be greater than or equal to ${ge}`, input, { ge });
    else if (le !== undefined && n > le) this.issue(name, "less_than_equal", `Input should be less than or equal to ${le}`, input, { le });
    return n;
  }

  private toInt(name: string, v: unknown, opts: Num): number {
    // " 7 ", "+7", "1_000" and "7.0" are integers, and so are true/false
    const m = typeof v === "string" ? /^\s*([+-]?\d+(?:_\d+)*)(?:\.0+)?\s*$/.exec(v) : null;
    if (m) return this.range(name, Number(m[1].replaceAll("_", "")), v, opts);
    if (typeof v === "boolean") return this.range(name, Number(v), v, opts);
    if (typeof v === "number" && Number.isInteger(v)) return this.range(name, v, v, opts);
    if (typeof v === "number") this.issue(name, "int_from_float", "Input should be a valid integer, got a number with a fractional part", v);
    else if (typeof v === "string") this.issue(name, "int_parsing", "Input should be a valid integer, unable to parse string as an integer", v);
    else this.issue(name, "int_type", "Input should be a valid integer", v);
    return 0;
  }

  /** A required integer (or `opts.default` when absent). */
  int(name: string, opts: Num = {}): number {
    const v = this.raw(name, opts.default === undefined, false);
    return v === undefined ? (opts.default ?? 0) : this.toInt(name, v, opts);
  }

  /** An optional integer (null when absent or null). */
  optInt(name: string, opts: Num = {}): number | null {
    const v = this.raw(name, false, true);
    return v === undefined ? null : this.toInt(name, v, opts);
  }

  /** A number with a default. */
  float(name: string, opts: Num & { default: number }): number {
    const v = this.raw(name, false, false);
    if (v === undefined) return opts.default;
    const n = typeof v === "number" || typeof v === "boolean" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isFinite(n)) return this.range(name, n, v, opts);
    if (typeof v === "string") this.issue(name, "float_parsing", "Input should be a valid number, unable to parse string as a number", v);
    else this.issue(name, "float_type", "Input should be a valid number", v);
    return opts.default;
  }

  /** A boolean, required unless it has a default (accepts true/false, 0/1 and the usual words). */
  bool(name: string, dflt?: boolean): boolean {
    const v = this.raw(name, dflt === undefined, false);
    if (v === undefined) return dflt ?? false;
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    if (["1", "true", "t", "yes", "y", "on"].includes(s) && typeof v !== "object") return true;
    if (["0", "false", "f", "no", "n", "off"].includes(s) && typeof v !== "object") return false;
    if (typeof v === "string") this.issue(name, "bool_parsing", "Input should be a valid boolean, unable to interpret input", v);
    else this.issue(name, "bool_type", "Input should be a valid boolean", v);
    return false;
  }

  private toStr(name: string, v: unknown, maxLength?: number): string {
    if (typeof v !== "string") {
      this.issue(name, "string_type", "Input should be a valid string", v);
      return "";
    }
    if (maxLength !== undefined && v.length > maxLength)
      this.issue(name, "string_too_long", `String should have at most ${maxLength} character${maxLength === 1 ? "" : "s"}`, v, { max_length: maxLength });
    return v;
  }

  /** A required string (or `opts.default` when absent). */
  str(name: string, opts: { default?: string; maxLength?: number } = {}): string {
    const v = this.raw(name, opts.default === undefined, false);
    return v === undefined ? (opts.default ?? "") : this.toStr(name, v, opts.maxLength);
  }

  /** An optional string (null when absent or null). */
  optStr(name: string, opts: { maxLength?: number } = {}): string | null {
    const v = this.raw(name, false, true);
    return v === undefined ? null : this.toStr(name, v, opts.maxLength);
  }

  /** A required nested object; its fields report problems into this reader. */
  object(name: string): Fields {
    const v = this.raw(name, true, false);
    if (v !== undefined && (typeof v !== "object" || v === null || Array.isArray(v)))
      this.issue(name, "model_type", "Input should be a valid dictionary or instance of the model", v);
    const data = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return new Fields(data, [...this.loc, name], v === undefined || data !== v ? [] : this.issues);
  }

  /** Throw a 422 listing every problem found so far (here and in `others`). */
  check(...others: Fields[]): void {
    const all = [...this.issues, ...others.flatMap((o) => o.issues)];
    if (all.length) throw new HttpError(422, all);
  }
}

/** The optional `year` field (query or body): at most 9 characters. */
export const yearField = (f: Fields) => f.optStr("year", { maxLength: 9 });
