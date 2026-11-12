/**
 * STUB written by the coordinator: signatures only. The scheduler agent replaces the
 * bodies with the port of src/utils.py (everything except the Neo4j settings/driver,
 * which live in lib/server/neo4j.ts).
 */
import type { Db, Row } from "./db";
import type { Grid } from "@/lib/types";

export const DAY_ORDER = ["MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Day = (typeof DAY_ORDER)[number];
export const DAY_NO: Record<string, number> = Object.fromEntries(DAY_ORDER.map((d, i) => [d, i + 1]));

const todo = (): never => {
  throw new Error("not implemented yet");
};

/** Plain-English explanation of a mysql2 error (errno 1062 / 1452 / 1451 / triggers 5001-5003). */
export function describeMysqlError(err: unknown): string { return todo(); } // eslint-disable-line
/** "HH:MM" or "HH:MM:SS" -> minutes since midnight. */
export function toMinutes(t: string): number { return todo(); } // eslint-disable-line
/** "08:30:00" -> "08:30". */
export function fmtTime(t: string): string { return todo(); } // eslint-disable-line
/** next/prev slot on the same day without a long break (gap >= longBreakMin breaks the link). */
export function buildSlotLinks(slots: Row[], longBreakMin = 30): { next: Map<number, number>; prev: Map<number, number> } { return todo(); } // eslint-disable-line
/** course -> other course -> shared qualified faculty + shared enrolled students. */
export async function buildConflictGraph(db: Db): Promise<Map<string, Map<string, number>>> { return todo(); } // eslint-disable-line
/** "Computer Science and Engineering" -> "CSE". */
export function deptCode(name: string): string { return todo(); } // eslint-disable-line
/** Port of utils.build_week_grid: classes carry day_of_week, period_no, course_id, course_type, lines. */
export function buildWeekGrid(slots: Row[], classes: Row[], breakMin = 30): Grid { return todo(); } // eslint-disable-line
/** Plain-text table for CLI output (port of utils.format_table). */
export function formatTable(rows: Row[], columns?: string[], maxRows = 20): string { return todo(); } // eslint-disable-line
