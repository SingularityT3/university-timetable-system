/**
 * Database rules: the schema, constraints, composite foreign keys and
 * triggers must REJECT invalid data. Every insert runs inside a rolled-back transaction and uses
 * TEST_YEAR, so real data is never touched.
 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { callProcedure, query } from "@/lib/server/db";
import { describeMysqlError } from "@/lib/server/utils";
import { TEST_YEAR, withRollback } from "./helpers";

type Cls = { course_id: string; faculty_id: number; room_id: number; slot_id: number; section_id: number };
const BASE: Cls = { course_id: "CS201", faculty_id: 1, room_id: 1, slot_id: 1, section_id: 1 };

function insert(c: PoolConnection, override: Partial<Cls> = {}, year = TEST_YEAR) {
  const r = { ...BASE, ...override };
  return c.query("INSERT INTO Timetable (course_id, faculty_id, room_id, slot_id, section_id, academic_year) " +
    "VALUES (?, ?, ?, ?, ?, ?)", [r.course_id, r.faculty_id, r.room_id, r.slot_id, r.section_id, year]);
}

const clearYear = (c: PoolConnection) => c.query("DELETE FROM Timetable WHERE academic_year = ?", [TEST_YEAR]);
const scalar = async (c: PoolConnection, sql: string) => (await query(c, sql))[0].v;

/** The mysql2 error a statement fails with (fails the test if it succeeds). */
async function mysqlError(p: Promise<unknown>): Promise<Error & { errno: number }> {
  const e = await p.then(() => null, (err) => err);
  expect(e, "statement was accepted").not.toBeNull();
  return e;
}

/** One valid class (section 1, CS201, faculty 1, room 1, slot 1) in TEST_YEAR, then fn; all rolled back. */
const withBaseRow = (fn: (c: PoolConnection) => Promise<void>) => withRollback(async (c) => {
  await clearYear(c);
  await insert(c); // must succeed: proves BASE is valid
  await fn(c);
});

// ----------------------------------------------------------------- structure
describe("structure", () => {
  it("has every schema object", () => withRollback(async (c) => {
    expect(await scalar(c, "SELECT COUNT(*) v FROM information_schema.tables WHERE table_schema = DATABASE() " +
      "AND table_type = 'BASE TABLE'")).toBe(12); // 11 timetable tables + AppUser
    expect(await scalar(c, "SELECT COUNT(*) v FROM information_schema.views WHERE table_schema = DATABASE()")).toBe(4);
    expect(await scalar(c, "SELECT COUNT(*) v FROM information_schema.triggers WHERE trigger_schema = DATABASE()")).toBe(4);
    const names = new Set((await query(c, "SELECT routine_name n FROM information_schema.routines " +
      "WHERE routine_schema = DATABASE()")).map((r) => r.n));
    for (const n of ["sp_validate_placement", "sp_faculty_workload", "sp_room_utilization", "sp_list_clashes",
      "sp_hours_coverage", "fn_faculty_load", "sp_department_summary", "sp_free_blocks"]) expect(names).toContain(n);
  }));

  it("has the seed data sizes", () => withRollback(async (c) => {
    const want = { Department: 3, Faculty: 20, Course: 30, Section: 10, Student: 120, Classroom: 25, TimeSlot: 48,
      Teaches: 62, Section_Course: 50, Enrollment: 600 };
    const got = Object.fromEntries(await Promise.all(Object.keys(want).map(async (t) => [t, await scalar(c, `SELECT COUNT(*) v FROM ${t}`)])));
    expect(got).toEqual(want);
  }));

  it("requires a faculty login to link to a Faculty row", () => withRollback(async (c) => {
    const e = await mysqlError(c.query("INSERT INTO AppUser (username, password_hash, role) VALUES ('t_nolink', 'x', 'faculty')"));
    expect([3819, 4025]).toContain(e.errno);
    await c.query("INSERT INTO AppUser (username, password_hash, role) VALUES ('t_admin', 'x', 'admin')");
  }));

  it("CHECK constraint rejects non-positive credits", () => withRollback(async (c) => {
    // CHECK constraints are enforced from MySQL 8.0.16 / MariaDB 10.2 (errors 3819 / 4025)
    const e = await mysqlError(c.query("INSERT INTO Course VALUES ('ZZ999', 'Bad', 0, 3, 'THEORY', 1)"));
    expect([3819, 4025]).toContain(e.errno);
  }));
});

// --------------------------------------------- hard constraints: no double booking
describe("unique keys reject double booking", () => {
  it.each([
    ["room clash", { section_id: 2, faculty_id: 2, room_id: 1, slot_id: 1 }, "room"],
    ["faculty clash", { section_id: 2, faculty_id: 1, room_id: 2, slot_id: 1 }, "faculty"],
    ["section clash", { course_id: "CS202", faculty_id: 3, room_id: 2, slot_id: 1, section_id: 1 }, "section"],
  ] as const)("%s", (_label, override, word) => withBaseRow(async (c) => {
    const e = await mysqlError(insert(c, override));
    expect(e.errno).toBe(1062);
    expect(describeMysqlError(e)).toContain(word);
  }));

  it("allows the same slot in another year (uniqueness is per academic year)", () => withBaseRow(async (c) => {
    await insert(c, {}, "2098-2099");
    await c.query("DELETE FROM Timetable WHERE academic_year = '2098-2099'");
  }));
});

// ------------------------------------------------------- triggers (rules 5001-5003)
describe("triggers", () => {
  it("reject a room smaller than the section", () => withRollback(async (c) => {
    const small = await scalar(c, "SELECT room_id v FROM Classroom WHERE room_type = 'LECTURE' AND capacity < " +
      "(SELECT strength FROM Section WHERE section_id = 1) LIMIT 1");
    const e = await mysqlError(insert(c, { room_id: small }));
    expect(e.errno).toBe(5001);
    expect(describeMysqlError(e)).toContain("capacity");
  }));

  it("reject a THEORY class in a LAB room", () => withRollback(async (c) => {
    const lab = await scalar(c, "SELECT room_id v FROM Classroom WHERE room_type = 'LAB' LIMIT 1");
    expect((await mysqlError(insert(c, { room_id: lab }))).errno).toBe(5002); // CS201 is THEORY
  }));

  it("reject a LAB class in a LECTURE room", () => withRollback(async (c) => {
    expect((await mysqlError(insert(c, { course_id: "CS205L", room_id: 1 }))).errno).toBe(5002);
  }));

  it("keep Section_Course.semester consistent", () => withRollback(async (c) => {
    // section 1 is semester 3
    const e = await mysqlError(c.query("INSERT INTO Section_Course (section_id, course_id, semester) VALUES (1, 'CS301', 5)"));
    expect(e.errno).toBe(5003);
  }));
});

// ------------------------------------------------- composite foreign keys (M2 / M3)
describe("composite foreign keys", () => {
  it("faculty must teach the course", () => withRollback(async (c) => {
    const e = await mysqlError(insert(c, { faculty_id: 20 })); // faculty 20 (MECH) does not teach CS201
    expect(e.errno).toBe(1452);
    expect(e.message).toContain("fk_tt_teaches");
    expect(describeMysqlError(e)).toContain("Teaches");
  }));

  it("course must be in the section plan", () => withRollback(async (c) => {
    // EC201 is taught by faculty 11 but not in section 1's plan
    const e = await mysqlError(insert(c, { course_id: "EC201", faculty_id: 11 }));
    expect(e.errno).toBe(1452);
    expect(e.message).toContain("fk_tt_section_course");
  }));

  it("a Teaches row in use cannot be deleted", () => withBaseRow(async (c) => {
    const e = await mysqlError(c.query("DELETE FROM Teaches WHERE faculty_id = 1 AND course_id = 'CS201'"));
    expect(e.errno).toBe(1451); // RESTRICT: still used by Timetable
  }));
});

// ------------------------------------------------------------- stored procedures
describe("stored procedures", () => {
  it("clash audit flags a rule violation that triggers cannot see", () => withBaseRow(async (c) => {
    // sp_list_clashes must catch drift: shrink a room AFTER a class was placed in it (section 1 (60) in room 1 (60))
    await c.query("UPDATE Classroom SET capacity = 10 WHERE room_id = 1"); // triggers do not watch this; rolled back
    const rows = await callProcedure(c, "sp_list_clashes", [TEST_YEAR]);
    expect(rows.some((r) => r.clash_type === "ROOM_CAPACITY_EXCEEDED")).toBe(true);
  }));

  it("hours coverage reports unscheduled sections", () => withRollback(async (c) => {
    await clearYear(c);
    const gaps = await callProcedure(c, "sp_hours_coverage", [TEST_YEAR]);
    expect(gaps).toHaveLength(50); // empty year: all 50 (section, course) pairs short
    expect(new Set(gaps.map((g) => g.status))).toEqual(new Set(["UNDER_SCHEDULED"]));
  }));
});
