/**
 * The scheduler. Results are re-validated by an INDEPENDENT checker
 * written here from the raw tables (not by generator internals), and by the database's own audit
 * procedures. Writes only touch TEST_YEAR or happen in rolled-back transactions.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callProcedure, pool, query, type Db } from "@/lib/server/db";
import {
  GenerationError, Scheduler, busyKey, checkProposedClass, generateTimetable, loadProblem, makeTasks, mulberry32,
  preflight, report, saveTimetable, splitHours, type GenerationResult, type TimetableRow,
} from "@/lib/server/generator";
import { TEST_YEAR, saveTestYear, wipeTestYear, withRollback } from "./helpers";

// ------------------------------------------------------------ independent checker
/** Every hard rule, recomputed from the MySQL tables. rows = (course, faculty, room, slot, section, year). */
async function hardViolations(db: Db, rows: TimetableRow[]): Promise<string[]> {
  const byKey = async (sql: string, key: string) => new Map((await query(db, sql)).map((r) => [r[key], r]));
  const rooms = await byKey("SELECT * FROM Classroom", "room_id");
  const courses = await byKey("SELECT * FROM Course", "course_id");
  const sections = await byKey("SELECT * FROM Section", "section_id");
  const teaches = new Set((await query(db, "SELECT * FROM Teaches")).map((r) => `${r.faculty_id}|${r.course_id}`));
  const plan = (await query(db, "SELECT * FROM Section_Course")).map((r) => [r.section_id, r.course_id] as const);
  const planKeys = new Set(plan.map(([s, c]) => `${s}|${c}`));
  const bad: string[] = [];
  const count = (keys: string[]) => keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
  for (const [name, idx] of [["room", 2], ["faculty", 1], ["section", 4]] as const) {
    for (const [k, n] of count(rows.map((r) => `${r[idx]} in slot ${r[3]}`))) if (n > 1) bad.push(`${name} ${k} double-booked`);
  }
  for (const [course, fac, room, , sec] of rows) {
    const c = courses.get(course)!, r = rooms.get(room)!, s = sections.get(sec)!;
    const need = c.course_type === "LAB" ? "LAB" : "LECTURE";
    if (r.room_type !== need) bad.push(`${course} (${c.course_type}) in ${r.room_type} room ${room}`);
    if (r.capacity < s.strength) bad.push(`room ${room} too small for section ${sec}`);
    if (!teaches.has(`${fac}|${course}`)) bad.push(`faculty ${fac} does not teach ${course}`);
    if (!planKeys.has(`${sec}|${course}`)) bad.push(`section ${sec} does not take ${course}`);
  }
  const per = count(rows.map((r) => `${r[4]}|${r[0]}`));
  for (const [sec, course] of plan) {
    const n = per.get(`${sec}|${course}`) ?? 0;
    if (n !== courses.get(course)!.weekly_hours) bad.push(`section ${sec} / ${course}: ${n} periods`);
  }
  return bad;
}

const dryRun = (opts: { seed?: number; restarts?: number } = {}) =>
  withRollback((conn) => generateTimetable({ academicYear: TEST_YEAR, dryRun: true, conn, ...opts }));

// ----------------------------------------------------------------- pure helpers
it.each([
  [3, "THEORY", [1, 1, 1]], [2, "LAB", [2]], [3, "LAB", [3]], [4, "LAB", [2, 2]], [5, "LAB", [3, 2]], [6, "LAB", [3, 3]],
])("splitHours(%i, %s)", (hours, kind, expected) => {
  expect(splitHours(hours, kind)).toEqual(expected);
});

// -------------------------------------------------------------- generation (dry)
describe("dry run on the seed data", () => {
  let res: GenerationResult;
  beforeAll(async () => {
    res = await dryRun();
  });

  it("finds a complete valid timetable", async () => {
    expect(res.complete && res.placed === res.required && res.required === 154, report(res)).toBe(true);
    expect(res.preflight).toEqual([]);
    expect(res.unplaced).toEqual([]);
    expect(res.committed).toBe(false);
    expect(await hardViolations(pool(), res.rows)).toEqual([]);
  });

  it("meets every soft constraint", () => {
    expect(res.soft).toEqual({ same_day_repeats: 0, faculty_long_runs: 0, lab_blocks_split: 0 });
  });

  it("keeps labs consecutive and never across lunch", async () => {
    const slots = new Map((await query(pool(), "SELECT * FROM TimeSlot")).map((s) => [s.slot_id, s]));
    const labs = new Set((await query(pool(), "SELECT course_id FROM Course WHERE course_type = 'LAB'")).map((r) => r.course_id));
    const groups = new Map<string, number[]>();
    for (const [course, , , slot, sec] of res.rows) {
      if (!labs.has(course)) continue;
      const key = `${course}|${sec}|${slots.get(slot)!.day_of_week}`;
      groups.set(key, [...(groups.get(key) ?? []), slots.get(slot)!.period_no]);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [key, periods] of groups) {
      periods.sort((a, b) => a - b);
      expect(periods, key).toEqual(periods.map((_, i) => periods[0] + i)); // consecutive
      expect(periods[0] <= 4 && 4 < periods.at(-1)!, `${key} spans lunch`).toBe(false);
    }
  });

  it("gives the same timetable for the same seed", async () => {
    const [a, b] = [await dryRun({ seed: 7 }), await dryRun({ seed: 7 })];
    expect(a.rows).toEqual(b.rows);
  });

  it("still searches once with zero restarts", async () => {
    const r = await dryRun({ restarts: 0 });
    expect(r.complete).toBe(true);
    expect(r.attempts).toBe(1);
  });
});

// --------------------------------------------------------------- saving (TEST_YEAR)
describe("saving", () => {
  let saved: GenerationResult;
  beforeAll(async () => {
    saved = await saveTestYear();
  });
  afterAll(wipeTestYear);

  const countSaved = async () =>
    (await query(pool(), "SELECT COUNT(*) AS v FROM Timetable WHERE academic_year = ?", [TEST_YEAR]))[0].v;

  it("passes the database audits", async () => {
    expect(await countSaved()).toBe(154);
    expect(await callProcedure(pool(), "sp_list_clashes", [TEST_YEAR])).toEqual([]); // zero clashes
    expect(await callProcedure(pool(), "sp_hours_coverage", [TEST_YEAR])).toEqual([]); // every course has its hours
    const util = await callProcedure(pool(), "sp_room_utilization", [TEST_YEAR]);
    expect(util).toHaveLength(25);
    expect(util.reduce((a, u) => a + u.used_slots, 0)).toBe(154);
  });

  it("is all or nothing: a bad row rolls everything back", async () => {
    const rows = [...saved.rows];
    const last = rows[rows.length - 1];
    const [stranger] = await query(pool(), "SELECT MIN(faculty_id) AS f FROM Faculty WHERE faculty_id NOT IN " +
      "(SELECT faculty_id FROM Teaches WHERE course_id = ?)", [last[0]]); // someone who does not teach that course
    rows[rows.length - 1] = [last[0], stranger.f, last[2], last[3], last[4], last[5]];
    const err = await pool().getConnection().then((c) =>
      saveTimetable(c, TEST_YEAR, rows).then(() => null, (e) => e).finally(() => c.release()));
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.message).toContain("fk_tt_teaches");
    expect(await countSaved()).toBe(154); // old timetable survived
  });

  it("checks a proposed class rule by rule", async () => {
    const [course, fac, room, slot, sec] = saved.rows[0];
    const rules = async (o: { fac?: number; room?: number } = {}) => Object.fromEntries(
      (await checkProposedClass(pool(), TEST_YEAR, sec, course, o.fac ?? fac, o.room ?? room, slot)).map((r) => [r.rule, r]));

    const same = await rules(); // exactly an existing class: everything clashes
    expect(same["Section is free in this slot"].ok).toBe(false);
    expect(same["Faculty is free in this slot"].ok).toBe(false);
    expect(same["Room is free in this slot"].ok).toBe(false);
    expect(Object.values(same).filter((r) => r.rule !== "Section still needs hours for this course").every((r) => r.hard)).toBe(true);

    const [lab] = await query(pool(), "SELECT room_id FROM Classroom WHERE room_type = 'LAB' LIMIT 1");
    expect((await rules({ room: lab.room_id }))["Room type fits the course"].ok).toBe(false);
    expect((await rules({ fac: 20 }))["Faculty is qualified (Teaches)"].ok).toBe(false);
  });

  it("refuses to overwrite without replace", async () => {
    const again = await generateTimetable({ academicYear: TEST_YEAR });
    expect(again.committed).toBe(false);
    expect(again.note).toContain("already exist");
    expect((await generateTimetable({ academicYear: TEST_YEAR, replace: true })).committed).toBe(true);
  });
});

// --------------------------------------------------------------- failure reporting
describe("failure reporting", () => {
  it("pre-flight names a course nobody teaches", async () => {
    const P = await loadProblem(pool());
    P.teach.set("CS201", []); // in memory only, DB untouched
    expect(preflight(P, makeTasks(P)).some((i) => i.includes("CS201") && i.includes("no faculty"))).toBe(true);
  });

  it("pre-flight catches a faculty pool that is too small", async () => {
    const P = await loadProblem(pool());
    P.courses.get("CS201")!.weekly_hours = 200;
    expect(preflight(P, makeTasks(P)).length).toBeGreaterThan(0);
  });

  it("diagnosis explains why a class cannot be placed", async () => {
    const P = await loadProblem(pool());
    const sched = new Scheduler(P, mulberry32(1));
    const task = makeTasks(P)[0];
    for (const slot of P.slotIds) sched.state.busySec.add(busyKey(task.sectionId, slot)); // section fully busy
    expect(sched.candidates(task)).toEqual([]);
    expect(sched.diagnose(task)).toContain("already used by the section");
  });

  it("impossible input is reported instead of crashing", async () => {
    // no lecture room is large enough: pre-flight explains it, nothing is written
    const res = await withRollback(async (conn) => {
      await conn.query("UPDATE Classroom SET capacity = 5 WHERE room_type = 'LECTURE'");
      return generateTimetable({ academicYear: TEST_YEAR, conn, replace: true });
    });
    expect(res.complete || res.committed).toBe(false);
    expect(res.preflight.some((p) => p.includes("LECTURE room"))).toBe(true);
  });

  it("search failure falls back to a clash-free partial timetable with reasons", async () => {
    // feasible on paper (pre-flight passes) but not in practice: only room 1 still seats a full section
    const res = await withRollback(async (conn) => {
      await conn.query("UPDATE Classroom SET capacity = 40 WHERE room_type = 'LECTURE' AND room_id <> 1");
      return generateTimetable({ academicYear: TEST_YEAR, conn, replace: true, timeLimit: 5, maxNodes: 5000 });
    });
    expect(res.preflight).toEqual([]);
    expect(res.complete || res.committed, report(res)).toBe(false);
    expect(res.placed > 0 && res.placed < res.required).toBe(true);
    expect(res.note).toContain("not saved");
    expect(res.unplaced.length).toBeGreaterThan(0);
    expect(res.unplaced.every((u) => u.reason.includes("no free LECTURE room"))).toBe(true);
    expect(res.unplaced.reduce((a, u) => a + u.periods, 0)).toBe(res.required - res.placed);
    const clashes = (await hardViolations(pool(), res.rows)).filter((v) => v.includes("double-booked") || v.includes(" room "));
    expect(clashes).toEqual([]); // partial, but never invalid
    expect(report(res)).toContain("PARTIAL");
    expect(report(res)).toContain("Could NOT be placed");
  });
});

// ------------------------------------------------------------------------- CLI
describe("CLI (scripts/generate.ts)", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    promisify(execFile)(path.resolve("node_modules/.bin/tsx"), ["scripts/generate.ts", ...args],
      { env: { ...process.env, ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: e.stdout, stderr: e.stderr }));

  it("dry run: exit code 0 and the report", async () => {
    const r = await run(["--year", TEST_YEAR, "--dry-run", "--seed", "3"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Result        : COMPLETE");
    expect(r.stdout).toContain("Saved to MySQL: no -- dry run");
  });

  it("explains an unreachable database (exit code 2)", async () => {
    const r = await run(["--dry-run"], { MYSQL_HOST: "127.0.0.1", MYSQL_PORT: "1", MYSQL_UNIX_SOCKET: "" }); // nothing listens on port 1
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Could not use MySQL");
  });
});
