/**
 * Shared fixtures for the server tests (port of tests/conftest.py).
 *
 * SAFETY RULE: tests never modify real data. Everything that writes uses the throw-away
 * academic year TEST_YEAR (wiped before and after), or runs inside a transaction that is
 * rolled back. Run DB tests under `flock /tmp/tt-db.lock` when another agent shares the stack.
 */
import type { PoolConnection } from "mysql2/promise";
import { expect } from "vitest";
import { pool, query } from "@/lib/server/db";
import { academicYear } from "@/lib/server/env";
import { generateTimetable, report, type GenerationResult } from "@/lib/server/generator";

export const TEST_YEAR = "2099-2100"; // VARCHAR(9); never used for real data

/** The real academic year (read-only use). */
export function realYear(): string {
  const y = academicYear();
  if (y === TEST_YEAR) throw new Error("ACADEMIC_YEAR must not be the test year");
  return y;
}

/** Run fn on a connection inside a transaction that is always rolled back. */
export async function withRollback<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool().getConnection();
  try {
    await c.beginTransaction();
    return await fn(c);
  } finally {
    await c.rollback().catch(() => {});
    c.release();
  }
}

/** Delete every Timetable row of TEST_YEAR (autocommit). */
export async function wipeTestYear(): Promise<void> {
  await query(pool(), "DELETE FROM Timetable WHERE academic_year = ?", [TEST_YEAR]);
}

/**
 * Wipe TEST_YEAR, then generate a full timetable for it and SAVE it. Pair with
 * `afterAll(wipeTestYear)` (or afterEach) so nothing is left behind.
 */
export async function saveTestYear(): Promise<GenerationResult> {
  await wipeTestYear();
  const res = await generateTimetable({ academicYear: TEST_YEAR, replace: true });
  expect(res.committed && res.complete, report(res)).toBe(true);
  return res;
}
