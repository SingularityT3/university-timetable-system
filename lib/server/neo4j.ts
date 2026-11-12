/**
 * Neo4j access: settings, one shared driver, and the documented Cypher queries.
 *
 * The Cypher text lives ONLY in cypher/queries.cypher; loadQueries() parses its
 * "// @query <name>" markers, so the functions below run exactly the documented statements.
 *
 *   Q1  impactAnalysis            Q7  facultyWorkloadRanking
 *   Q2  substituteFinder          Q8  moveClassRipple
 *   Q3  mostConflictedCourses     Q9  crossDepartmentTeaching
 *   Q4  freeRooms                 Q10 courseConflictNeighbours
 *   Q5  heaviestDayStudents       Q11/12 nodeCounts / relationshipCounts
 *   Q6  facultyShortestPath       Q13/14 browseNodes / nodeNeighbours
 *   Q15-17 listUnavailability / setUnavailability / deleteUnavailability (graph CRUD)
 *   + facultyAbsencePlan(): Q1 + Q2 combined for the "faculty absent" page
 *
 * Everything returns plain objects (integers as numbers, temporal values as ISO text).
 * The driver only reports server notifications in result summaries (it does not log them),
 * so no notice filtering is needed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import neo4j, { type Driver, type ManagedTransaction, type Session } from "neo4j-driver";
import type { Row } from "./db";
import { env, PROJECT_ROOT, academicYear } from "./env";
import { DAY_ORDER } from "./utils";

export const QUERY_FILE = join(PROJECT_ROOT, "cypher", "queries.cypher");
const MARKER = /^\s*\/\/\s*@query\s+(\w+)\s*$/;

/** Bad argument (the API answers 400). */
export class InputError extends Error {}
/** Unknown node / class / slot (the API answers 404). */
export class NotFoundError extends Error {}
/** Neo4j is not configured (missing password). */
export class Neo4jConfigError extends Error {}

/** List text for messages: ['MON', 'TUE']. */
export const pyList = (xs: readonly string[]) => `[${xs.map((x) => `'${x}'`).join(", ")}]`;

// --------------------------------------------------------------- settings
export interface Neo4jSettings { uri: string; user: string; password: string; database: string }

/** NEO4J_URI (bolt://localhost:7687), NEO4J_USER (neo4j), NEO4J_PASSWORD (required), NEO4J_DATABASE (neo4j). */
export function neo4jSettings(): Neo4jSettings {
  return {
    uri: env("NEO4J_URI", "bolt://localhost:7687")!,
    user: env("NEO4J_USER", "neo4j")!,
    password: env("NEO4J_PASSWORD", "")!,
    database: env("NEO4J_DATABASE", "neo4j")!,
  };
}

/** Parse a .env file (KEY=VALUE per line, '#' comments) into an object. Missing file -> {}. */
export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  }
  return values;
}

/**
 * The Neo4j settings the code will use, WITHOUT the password: its length, first/last
 * character and where it came from (.env file, or a real environment variable overriding .env).
 */
export function describeNeo4jSettings(envPath = join(PROJECT_ROOT, ".env")): string[] {
  const s = neo4jSettings();
  const pw = s.password;
  let pwText = "NOT SET";
  if (pw) {
    const inFile = readEnvFile(envPath).NEO4J_PASSWORD;
    const source =
      inFile === undefined ? "real environment variable (not in .env)"
      : inFile !== pw ? "real environment variable, OVERRIDING a different value in .env"
      : ".env file";
    pwText = `${pw.length} chars, starts '${pw[0]}', ends '${pw[pw.length - 1]}'  [source: ${source}]`;
  }
  return [`URI       : ${s.uri}`, `User      : ${s.user}`, `Password  : ${pwText}`, `Database  : ${s.database}`];
}

// ----------------------------------------------------------------- driver
function createDriver(): Driver {
  const s = neo4jSettings();
  if (!s.password) throw new Neo4jConfigError("NEO4J_PASSWORD is not set. Put it in .env or export it.");
  return neo4j.driver(s.uri, neo4j.auth.basic(s.user, s.password), { disableLosslessIntegers: true });
}

/** Indirections the module calls through, so tests can stand in for the server. */
export const io = {
  createDriver,
  read: (name: string, params?: Record<string, unknown>, session?: ReadSession) => runQuery(name, params, session),
  write: (name: string, params?: Record<string, unknown>) => runWrite(name, params),
};

// one driver per process, kept on globalThis so Next.js dev reloads do not leak it
const g = globalThis as { __ttNeo4j?: Driver };

/**
 * The shared driver. A cached driver is checked first (one round trip): if the server went
 * away the caller gets the error at once instead of the driver retrying for ~30 s, and the
 * driver is rebuilt once the server is back.
 */
export async function getDriver(): Promise<Driver> {
  if (g.__ttNeo4j) {
    try {
      await g.__ttNeo4j.verifyConnectivity();
      return g.__ttNeo4j;
    } catch {
      await closeDriver();
    }
  }
  const drv = io.createDriver();
  try {
    await drv.verifyConnectivity(); // fail fast instead of retrying
  } catch (e) {
    await drv.close();
    throw e;
  }
  if (g.__ttNeo4j) {
    await drv.close(); // a concurrent caller was quicker
    return g.__ttNeo4j;
  }
  return (g.__ttNeo4j = drv);
}

export async function closeDriver(): Promise<void> {
  const d = g.__ttNeo4j;
  g.__ttNeo4j = undefined;
  await d?.close();
}

/**
 * Why Neo4j cannot be used, as a short name ("ServiceUnavailable", "AuthError", ...),
 * or null when `err` is some other error.
 */
export function neo4jDownReason(err: unknown): string | null {
  if (err instanceof Neo4jConfigError) return "Neo4jConfigError";
  if (!(err instanceof neo4j.Neo4jError)) return null;
  if (err.code === "ServiceUnavailable" || err.code === "SessionExpired") return err.code;
  if (err.code.startsWith("Neo.ClientError.Security.")) return "AuthError";
  return null;
}

// ---------------------------------------------------------------- queries
/** Parse queries.cypher into {name: cypher text}. Comments are kept (Cypher ignores them). */
export function loadQueries(path = QUERY_FILE): Record<string, string> {
  const blocks: Record<string, string[]> = {};
  let name: string | null = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = MARKER.exec(line);
    if (m) blocks[(name = m[1])] = [];
    else if (name !== null) blocks[name].push(line);
  }
  return Object.fromEntries(
    Object.entries(blocks).map(([n, lines]) => {
      const body = lines.join("\n").trim();
      return [n, body.endsWith(";") ? body.slice(0, -1).trimEnd() : body]; // drop the trailing ';'
    }),
  );
}

let cache: Record<string, string> | null = null;
export function queries(): Record<string, string> {
  return (cache ??= loadQueries());
}

function cypherOf(name: string): string {
  const qs = queries();
  if (!(name in qs)) throw new Error(`unknown query '${name}'. Available: ${Object.keys(qs).join(", ")}`);
  return qs[name];
}

/** JS numbers become Floats in Cypher: send whole numbers as Integers (LIMIT and the keys need them). */
export function toCypher(value: unknown): unknown {
  if (typeof value === "number" && Number.isInteger(value)) return neo4j.int(value);
  if (Array.isArray(value)) return value.map(toCypher);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toCypher(v)]));
  return value;
}

/** Neo4j values -> JSON-friendly values (temporal types as ISO text, UTC as "+00:00"). */
export function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (neo4j.isDateTime(value)) return value.toString().replace(/Z$/, "+00:00");
  if (
    neo4j.isDate(value) || neo4j.isLocalDateTime(value) ||
    neo4j.isTime(value) || neo4j.isLocalTime(value) || neo4j.isDuration(value)
  )
    return value.toString();
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  return value;
}

/** What runQuery needs from a session (the ETL passes its own). */
export interface ReadSession {
  executeRead<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
}

async function rowsOf(tx: ManagedTransaction, cypher: string, params: Record<string, unknown>): Promise<Row[]> {
  const res = await tx.run(cypher, toCypher(params) as Record<string, unknown>);
  return res.records.map((r) => toPlain(r.toObject()) as Row);
}

async function withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
  const s = (await getDriver()).session({ database: neo4jSettings().database });
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

/** Run a named query (read transaction); pass `session` to reuse one, as the ETL does. */
export async function runQuery(name: string, params: Record<string, unknown> = {}, session?: ReadSession): Promise<Row[]> {
  const cypher = cypherOf(name);
  const work = (tx: ManagedTransaction) => rowsOf(tx, cypher, params);
  return session ? session.executeRead(work) : withSession((s) => s.executeRead(work));
}

/** Run a named WRITE query (write transaction) and return its rows. */
export async function runWrite(name: string, params: Record<string, unknown> = {}): Promise<Row[]> {
  const cypher = cypherOf(name);
  return withSession((s) => s.executeWrite((tx) => rowsOf(tx, cypher, params)));
}

// ---------------------------------------------------------------- wrappers
/** Normalise a day argument to 'MON'..'SAT' (null for the whole week). */
function day(d: string | null | undefined): string | null {
  if (d === null || d === undefined || String(d).trim() === "") return null;
  const v = String(d).trim().toUpperCase().slice(0, 3);
  if (!(DAY_ORDER as readonly string[]).includes(v)) throw new InputError(`day must be one of ${pyList(DAY_ORDER)}, got '${d}'`);
  return v;
}
const year = (y?: string | null) => y || academicYear();
/** A whole number (raises InputError otherwise). */
function int(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : /^\s*[+-]?\d+\s*$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n)) throw new InputError(`${what} must be an integer, got '${v}'`);
  return n;
}

/** Q1: classes lost if `facultyId` is absent (whole week or one day). */
export function impactAnalysis(facultyId: number, academicYear?: string | null, d?: string | null) {
  return io.read("impact_analysis", { faculty_id: int(facultyId, "faculty_id"), academic_year: year(academicYear), day: day(d) });
}

/** Q2 (raw): one row per (affected class, free same-department candidate). */
export function substituteFinder(facultyId: number, academicYear?: string | null, d?: string | null) {
  return io.read("substitute_finder", { faculty_id: int(facultyId, "faculty_id"), academic_year: year(academicYear), day: day(d) });
}

export type ClassStatus = "COVERABLE" | "NEEDS_TEACHES" | "UNCOVERED";

/**
 * Q1 + Q2 for the "faculty absent" page: every class carries its `substitutes`
 * (QUALIFIED first) and a status: COVERABLE (a QUALIFIED substitute is free),
 * NEEDS_TEACHES (only RELATED candidates: a Teaches row must be added first), UNCOVERED.
 */
export async function facultyAbsencePlan(facultyId: number, academicYear?: string | null, d?: string | null) {
  const classes = await impactAnalysis(facultyId, academicYear, d);
  const byClass = new Map<number, Row[]>();
  for (const row of await substituteFinder(facultyId, academicYear, d))
    byClass.set(row.timetable_id, [...(byClass.get(row.timetable_id) ?? []), row]);

  const counts: Record<ClassStatus, number> = { COVERABLE: 0, NEEDS_TEACHES: 0, UNCOVERED: 0 };
  for (const c of classes) {
    const subs = byClass.get(c.timetable_id) ?? [];
    c.substitutes = subs;
    c.status = subs.some((s) => s.fit === "QUALIFIED") ? "COVERABLE" : subs.length ? "NEEDS_TEACHES" : "UNCOVERED";
    counts[c.status as ClassStatus] += 1;
  }
  const sections = new Map(classes.map((c) => [c.section_id, c.students as number])); // students per distinct section
  const summary = {
    classes_affected: classes.length,
    sections_affected: sections.size,
    students_affected: [...sections.values()].reduce((a, b) => a + b, 0),
    coverable: counts.COVERABLE,
    needs_teaches_row: counts.NEEDS_TEACHES,
    uncovered: counts.UNCOVERED,
  };
  return { classes, summary };
}

/** Q3: courses that collide with the most (and most heavily shared) others. */
export function mostConflictedCourses(limit = 10) {
  return io.read("most_conflicted_courses", { limit: int(limit, "limit") });
}

/** Q4: rooms free in (day, period), optionally by minimum capacity and type. */
export function freeRooms(d: string, period: number, minCapacity = 0, roomType: string | null = null, academicYear?: string | null) {
  const v = day(d);
  if (v === null) throw new InputError("day is required");
  if (roomType !== null) {
    roomType = roomType.toUpperCase();
    if (roomType !== "LECTURE" && roomType !== "LAB") throw new InputError("room_type must be 'LECTURE', 'LAB' or None");
  }
  return io.read("free_rooms", {
    day: v, period: int(period, "period"), min_capacity: int(minCapacity, "min_capacity"),
    room_type: roomType, academic_year: year(academicYear),
  });
}

/** Q5: students whose busiest day has the most periods. */
export async function heaviestDayStudents(limit = 10, academicYear?: string | null) {
  const rows = await io.read("heaviest_day_students", { limit: int(limit, "limit"), academic_year: year(academicYear) });
  const order = (x: string) => (DAY_ORDER as readonly string[]).indexOf(x);
  for (const r of rows) r.days = [...r.days].sort((a: string, b: string) => order(a) - order(b)); // ties come unordered
  return rows;
}

/** Q6: shortest chain linking two faculty through shared courses/sections. */
export async function facultyShortestPath(fromId: number, toId: number) {
  const [from, to] = [int(fromId, "from_id"), int(toId, "to_id")];
  if (from === to) throw new InputError("from_id and to_id must be different faculty");
  const rows = await io.read("faculty_shortest_path", { from_id: from, to_id: to });
  if (!rows.length) return { connected: false, hops: null, path: [] };
  return { connected: true, hops: rows[0].hops as number, path: rows[0].path as { kind: string; name: string }[] };
}

/** Q7: faculty ranked by periods per week (adds a dense `rank`). */
export async function facultyWorkloadRanking(academicYear?: string | null) {
  const rows = await io.read("faculty_workload", { academic_year: year(academicYear) });
  let rank = 0;
  let prev: unknown = undefined;
  for (const r of rows) {
    if (r.periods !== prev) [rank, prev] = [rank + 1, r.periods];
    r.rank = rank;
  }
  return rows;
}

/** Q8: what collides if class `timetableId` moves to (day, period). */
export async function moveClassRipple(timetableId: number, d: string, period: number) {
  const v = day(d);
  if (v === null) throw new InputError("day is required");
  const rows = await io.read("move_class_ripple", { timetable_id: int(timetableId, "timetable_id"), day: v, period: int(period, "period") });
  if (!rows.length) throw new NotFoundError(`no class with timetable_id=${timetableId}, or no slot ${v} P${period}`);
  const keys = ["moved_timetable_id", "moved_course", "moved_section", "from_day", "from_period", "to_day", "to_period"];
  const moved = Object.fromEntries(keys.map((k) => [k, rows[0][k]]));
  const clashes = rows.filter((r) => r.clash_timetable_id !== null);
  return {
    moved, clashes, free_move: clashes.length === 0,
    students_displaced: clashes.reduce((a, r) => a + r.students_displaced, 0),
  };
}

/** Q9: faculty qualified for another department's courses. */
export function crossDepartmentTeaching() {
  return io.read("cross_department_teaching");
}

/** Q10: courses sharing faculty/students with `courseId`. */
export function courseConflictNeighbours(courseId: string) {
  return io.read("course_conflict_neighbours", { course_id: courseId });
}

/** Q11: {label: count}. */
export async function nodeCounts(session?: ReadSession): Promise<Record<string, number>> {
  return Object.fromEntries((await io.read("node_counts", {}, session)).map((r) => [r.label, r.nodes]));
}

/** Q12: {relationship type: count}. */
export async function relationshipCounts(session?: ReadSession): Promise<Record<string, number>> {
  return Object.fromEntries((await io.read("relationship_counts", {}, session)).map((r) => [r.rel_type, r.relationships]));
}

// ------------------------------------------------- Q13 - Q17 graph browser / CRUD
export const LABEL_KEYS: Record<string, string> = {
  Department: "dept_id", Faculty: "faculty_id", Course: "course_id", Section: "section_id",
  Student: "student_id", Classroom: "room_id", TimeSlot: "slot_id",
};
const STRING_KEYS = new Set(["Course", "Student"]); // every other key is an INT
export const MAX_REASON = 200;
const clampLimit = (limit: number) => Math.max(1, Math.min(int(limit, "limit"), 500));

function label(l: string): string {
  if (!(l in LABEL_KEYS)) throw new InputError(`label must be one of ${pyList(Object.keys(LABEL_KEYS).sort())}, got '${l}'`);
  return l;
}

/** Q13: nodes of `label` (key/name contains `search`, case-insensitive) with their degree. */
export function browseNodes(l: string, search?: string | null, limit = 50) {
  return io.read("node_browser", { label: label(l), search: (search ?? "").trim().slice(0, 100) || null, limit: clampLimit(limit) });
}

/** Q14: relationships of one node (type, OUT/IN, other end's label, key and name). */
export function nodeNeighbours(l: string, key: string | number, limit = 200) {
  const k = STRING_KEYS.has(label(l)) ? String(key) : int(key, `key of a ${l}`);
  return io.read("node_neighbours", { label: l, key: k, limit: clampLimit(limit) });
}

/** Q15: UNAVAILABLE_AT marks of one faculty member (or of everyone). */
export function listUnavailability(facultyId: number | null = null) {
  return io.read("faculty_unavailability", { faculty_id: facultyId === null ? null : int(facultyId, "faculty_id") });
}

/** Q16: create or update the mark (faculty unavailable in that slot) and return it. */
export async function setUnavailability(facultyId: number, slotId: number, reason = ""): Promise<Row> {
  reason = (reason ?? "").trim();
  if (reason.length > MAX_REASON) throw new InputError(`reason must be at most ${MAX_REASON} characters`);
  const rows = await io.write("set_unavailability", { faculty_id: int(facultyId, "faculty_id"), slot_id: int(slotId, "slot_id"), reason });
  if (!rows.length) throw new NotFoundError(`no faculty ${facultyId} or no time slot ${slotId} in the graph`);
  return rows[0];
}

/** Q17: remove the mark; returns how many were deleted (0 or 1). */
export async function deleteUnavailability(facultyId: number, slotId: number): Promise<number> {
  const rows = await io.write("delete_unavailability", { faculty_id: int(facultyId, "faculty_id"), slot_id: int(slotId, "slot_id") });
  return rows[0].deleted;
}
