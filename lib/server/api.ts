/** Logic shared by several route handlers (port of the helpers in api/main.py). */
import { query, type Db, type Row } from "./db";
import { academicYear } from "./env";
import { runEtl } from "./etl";
import { describeError } from "./http";
import { facultyWorkloadRanking, getDriver, neo4jDownReason } from "./neo4j";

export const yearOrDefault = (year: string | null | undefined) => year || academicYear();

const TIME = /^\d{2}:\d{2}:\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

/** JSON-friendly MySQL rows: TIME "08:30:00" -> "08:30", "2026-01-02 10:00:00" -> ISO "2026-01-02T10:00:00". */
export function clean<T extends Row | Row[]>(rows: T): T {
  const fix = (r: Row) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
      typeof v !== "string" ? v : TIME.test(v) ? v.slice(0, 5) : TIMESTAMP.test(v) ? v.replace(" ", "T") : v]));
  return (Array.isArray(rows) ? rows.map(fix) : fix(rows)) as T;
}

export async function countClasses(db: Db, year: string): Promise<number> {
  return Number((await query(db, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [year]))[0].n);
}

/** [reachable, "connected" or why not] */
export async function neo4jStatus(): Promise<[boolean, string]> {
  try {
    await getDriver();
    return [true, "connected"];
  } catch (e) {
    return [false, neo4jDownReason(e) ?? (e as Error).name ?? "Error"];
  }
}

/**
 * Compare the Neo4j graph with MySQL for `year` (classes per faculty member, so a reassigned
 * class is noticed too). null when equal or when Neo4j is unreachable.
 */
export async function graphStaleMessage(db: Db, year: string): Promise<string | null> {
  let rows: Row[];
  try {
    rows = await facultyWorkloadRanking(year);
  } catch {
    return null; // the plan call reports Neo4j errors
  }
  const inGraph = new Map<number, number>(rows.filter((r) => r.periods).map((r) => [r.faculty_id, r.periods]));
  const inMysql = new Map<number, number>(
    (await query(db, "SELECT faculty_id, COUNT(*) AS n FROM Timetable WHERE academic_year = ? GROUP BY faculty_id", [year]))
      .map((r) => [r.faculty_id, Number(r.n)]));
  const differ = [...new Set([...inGraph.keys(), ...inMysql.keys()])]
    .reduce((n, f) => n + (inGraph.get(f) === inMysql.get(f) ? 0 : (inGraph.has(f) ? 1 : 0) + (inMysql.has(f) ? 1 : 0)), 0);
  if (differ === 0) return null;
  const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return `The Neo4j graph differs from MySQL for ${year} (graph: ${total(inGraph)} classes, ` +
    `MySQL: ${total(inMysql)}; ${differ} per-faculty count(s) differ). Results below may be out of date.`;
}

/** Re-run the ETL for `year` after a MySQL change; returns a problem text or null. */
export async function refreshGraph(year: string): Promise<string | null> {
  try {
    const result = await runEtl(year, { log: () => {}, role: "admin" });
    return result.ok ? null : "Neo4j graph does not match MySQL: " + result.problems.join("; ");
  } catch (e) { // MySQL is already updated
    return `MySQL is updated, but refreshing Neo4j failed (${(e as Error).name}: ${(e as Error).message}).`;
  }
}

/** Run a Neo4j call for an optional part of a response: an explained error becomes {error: detail}. */
export async function orGraphError<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    const known = describeError(e);
    if (known && typeof known.detail === "string" && [400, 404, 503].includes(known.status)) return { error: known.detail };
    throw e;
  }
}
