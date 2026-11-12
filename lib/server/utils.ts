/**
 * Helpers shared by the generator, ETL, queries, API routes and tests (the Neo4j settings and
 * driver live in lib/server/neo4j.ts).
 *
 *   describeMysqlError        turn MySQL errors into plain English
 *   toMinutes / fmtTime       TIME strings
 *   buildSlotLinks            "which period follows which" (breaks aware)
 *   buildConflictGraph        course-vs-course conflict weights
 *   deptCode / buildWeekGrid  UI helpers;  formatTable  CLI tables
 */
import { query, type Db, type Row } from "./db";
import type { Grid, GridClass, GridRow } from "@/lib/types";

export const DAY_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Day = (typeof DAY_ORDER)[number];
export const DAY_NO: Record<string, number> = Object.fromEntries(DAY_ORDER.map((d, i) => [d, i + 1]));

// ---------------------------------------------------------------- MySQL error translation
const UNIQUE_MEANING: Record<string, string> = {
  uq_room_slot: "that room is already booked in that slot",
  uq_faculty_slot: "that faculty member already teaches in that slot",
  uq_section_slot: "that section already has a class in that slot",
};
const FK_MEANING: Record<string, string> = {
  fk_tt_teaches: "the faculty member is not listed in Teaches for that course",
  fk_tt_section_course: "that course is not in the section's Section_Course plan",
  fk_tt_course: "unknown course",
  fk_tt_faculty: "unknown faculty",
  fk_tt_room: "unknown room",
  fk_tt_slot: "unknown time slot",
  fk_tt_section: "unknown section",
};
const TRIGGER_MEANING: Record<number, string> = {
  5001: "room capacity is smaller than the section strength",
  5002: "course type does not match the room type (LAB->LAB, THEORY->LECTURE)",
  5003: "Section_Course.semester does not match Section.semester",
};

/** Plain-English explanation of a mysql2 error (errno 1062 / 1452 / 1451 / triggers 5001-5003). */
export function describeMysqlError(err: unknown): string {
  const e = (err ?? {}) as { errno?: number; sqlMessage?: string; message?: string };
  const errno = e.errno;
  const msg = e.sqlMessage || e.message || String(err);
  if (errno === 1062) {
    const m = /for key '([^']+)'/.exec(msg);
    const key = m ? m[1].split(".").pop()! : "?";
    return `clash (${key}): ${UNIQUE_MEANING[key] ?? "duplicate row"}`;
  }
  if (errno === 1452 || errno === 1451) {
    const m = /CONSTRAINT `([^`]+)`/.exec(msg);
    const name = m ? m[1] : "?";
    const meaning = errno === 1451 ? "the row is still used by the timetable" : (FK_MEANING[name] ?? "referenced row missing");
    return `foreign key ${name}: ${meaning}`;
  }
  if (errno !== undefined && errno in TRIGGER_MEANING) return `rule ${errno}: ${TRIGGER_MEANING[errno]}`;
  return `MySQL error ${errno ?? "None"}: ${msg}`;
}

// ---------------------------------------------------------------- time-slot geometry
/** "HH:MM" or "HH:MM:SS" -> minutes since midnight. */
export function toMinutes(t: string): number {
  if (typeof t !== "string") throw new TypeError(`unsupported time value: ${String(t)}`);
  const [h = 0, m = 0, s = 0] = t.split(":").map(Number);
  return h * 60 + m + s / 60;
}

/** "08:30:00" -> "08:30". */
export function fmtTime(t: string): string {
  const m = Math.round(toMinutes(t));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * next/prev: slot_id -> slot_id of the period that directly follows/precedes it ON THE SAME DAY
 * WITHOUT A LONG BREAK (period_no differs by 1 and the gap is < longBreakMin). With the seed data
 * the 15-minute tea breaks keep periods linked, the 55-minute lunch (P4->P5) does not.
 */
export function buildSlotLinks(slots: Row[], longBreakMin = 30): { next: Map<number, number>; prev: Map<number, number> } {
  const byDay = new Map<string, Row[]>();
  for (const s of slots) byDay.set(s.day_of_week, [...(byDay.get(s.day_of_week) ?? []), s]);
  const next = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const day of byDay.values()) {
    day.sort((a, b) => a.period_no - b.period_no);
    for (let i = 0; i + 1 < day.length; i++) {
      const [a, b] = [day[i], day[i + 1]];
      const gap = toMinutes(b.start_time) - toMinutes(a.end_time);
      if (b.period_no === a.period_no + 1 && gap < longBreakMin) {
        next.set(a.slot_id, b.slot_id);
        prev.set(b.slot_id, a.slot_id);
      }
    }
  }
  return { next, prev };
}

// ---------------------------------------------------------------- conflict graph
/**
 * Course conflict graph: course -> other course -> shared_count, where
 * shared_count = (# faculty qualified for both, from Teaches) + (# students enrolled in both).
 * Undirected (stored both ways); the Neo4j CONFLICTS_WITH relationship uses the same definition.
 */
export async function buildConflictGraph(db: Db): Promise<Map<string, Map<string, number>>> {
  const graph = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, n: number) => {
    if (!graph.has(a)) graph.set(a, new Map());
    const nb = graph.get(a)!;
    nb.set(b, (nb.get(b) ?? 0) + n);
  };
  for (const [table, key] of [["Teaches", "faculty_id"], ["Enrollment", "student_id"]]) {
    const rows = await query(db,
      `SELECT a.course_id AS c1, b.course_id AS c2, COUNT(*) AS n FROM ${table} a JOIN ${table} b ` +
      `ON a.${key} = b.${key} AND a.course_id < b.course_id GROUP BY a.course_id, b.course_id`);
    for (const { c1, c2, n } of rows) {
      add(c1, c2, Number(n));
      add(c2, c1, Number(n));
    }
  }
  return graph;
}

// ---------------------------------------------------------------- UI / CLI helpers
/** "Computer Science and Engineering" -> "CSE" (initials of capitalised words). */
export function deptCode(name: string): string {
  return name.split(/\s+/).filter((w) => w && w[0] !== w[0].toLowerCase()).map((w) => w[0]).join("");
}

/**
 * Arrange classes (day_of_week, period_no, course_id, course_type, lines) into a weekly grid:
 * one "period" row per period_no with a cell per day, plus a "break" row wherever the gap between
 * two periods is >= breakMin minutes ("Lunch" from 45 minutes; the 15-minute tea breaks are not shown).
 */
export function buildWeekGrid(slots: Row[], classes: Row[], breakMin = 30): Grid {
  const days: string[] = DAY_ORDER.filter((d) => slots.some((s) => s.day_of_week === d));
  const periods = new Map<number, Row>();
  for (const s of slots) if (!periods.has(s.period_no)) periods.set(s.period_no, s);
  const cells = new Map<string, GridClass[]>();
  for (const c of classes) {
    const k = `${c.day_of_week}|${c.period_no}`;
    cells.set(k, [...(cells.get(k) ?? []), c as GridClass]);
  }
  const rows: GridRow[] = [];
  let prev: Row | undefined;
  for (const p of [...periods.keys()].sort((a, b) => a - b)) {
    const s = periods.get(p)!;
    if (prev) {
      const gap = toMinutes(s.start_time) - toMinutes(prev.end_time);
      if (gap >= breakMin) {
        rows.push({ kind: "break", label: gap >= 45 ? "Lunch" : "Break",
          sub: `${fmtTime(prev.end_time)} - ${fmtTime(s.start_time)}`, cells: {} });
      }
    }
    rows.push({ kind: "period", label: `P${p}`, sub: `${fmtTime(s.start_time)} - ${fmtTime(s.end_time)}`,
      cells: Object.fromEntries(days.map((d) => [d, cells.get(`${d}|${p}`) ?? []])) });
    prev = s;
  }
  return { days, rows };
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (Array.isArray(v)) return v.length ? v.map(cell).join(", ") : "-";
  if (typeof v === "object") return Object.values(v).map(String).join(":");
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** Render rows as an aligned plain-text table (all rows when maxRows is omitted). */
export function formatTable(rows: Row[], columns?: string[], maxRows?: number): string {
  if (!rows.length) return "(no rows)";
  const cols = columns ?? Object.keys(rows[0]);
  const shown = maxRows === undefined ? rows : rows.slice(0, maxRows);
  const body = shown.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((b) => b[i].length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  const out = [line(cols), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)];
  if (maxRows !== undefined && rows.length > maxRows) out.push(`... ${rows.length - maxRows} more row(s)`);
  return out.join("\n");
}
