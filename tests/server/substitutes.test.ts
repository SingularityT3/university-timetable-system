/**
 * Substitute assignment (assignSubstitute / revertSubstitution; port of tests/test_substitutes.py).
 * These tests COMMIT (the functions are transactional by design), so they only touch TEST_YEAR
 * classes; any Teaches row they add is removed afterwards.
 */
import type { PoolConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callProcedure, pool, query, withConnection, type Row } from "@/lib/server/db";
import { SubstitutionError, assignSubstitute, revertSubstitution } from "@/lib/server/generator";
import { TEST_YEAR, saveTestYear, wipeTestYear } from "./helpers";

const teachesKeys = async () => new Set((await query(pool(), "SELECT * FROM Teaches")).map((r) => `${r.faculty_id}|${r.course_id}`));
let before: Set<string>;

beforeEach(async () => {
  before = await teachesKeys();
  await saveTestYear();
});

afterEach(async () => {
  await wipeTestYear(); // frees the FK first
  for (const k of await teachesKeys()) {
    if (!before.has(k)) await query(pool(), "DELETE FROM Teaches WHERE faculty_id = ? AND course_id = ?", k.split("|"));
  }
});

const classes = () => query(pool(), "SELECT * FROM Timetable WHERE academic_year = ? ORDER BY timetable_id", [TEST_YEAR]);

/** A faculty member (not the current one) free in the class's slot, qualified for the course or not. */
async function freeFaculty(cls: Row, qualified: boolean): Promise<number | null> {
  const rows = await query(pool(), "SELECT f.faculty_id FROM Faculty f WHERE f.faculty_id <> ? " +
    "AND f.faculty_id NOT IN (SELECT faculty_id FROM Timetable WHERE academic_year = ? AND slot_id = ?) AND " +
    (qualified ? "" : "NOT ") + "EXISTS (SELECT 1 FROM Teaches t WHERE t.faculty_id = f.faculty_id AND t.course_id = ?) " +
    "ORDER BY f.faculty_id", [cls.faculty_id, TEST_YEAR, cls.slot_id, cls.course_id]);
  return rows[0]?.faculty_id ?? null;
}

async function firstWith(qualified: boolean): Promise<[Row, number]> {
  for (const cls of await classes()) {
    const fac = await freeFaculty(cls, qualified);
    if (fac !== null) return [cls, fac];
  }
  throw new Error("no suitable class/faculty combination in the generated timetable");
}

const facultyOf = async (tid: number) =>
  (await query(pool(), "SELECT faculty_id FROM Timetable WHERE timetable_id = ?", [tid]))[0].faculty_id;
const teaches = async (fac: number, course: string) =>
  (await query(pool(), "SELECT 1 AS x FROM Teaches WHERE faculty_id = ? AND course_id = ?", [fac, course])).length > 0;
const onConn = <T>(fn: (c: PoolConnection) => Promise<T>) => withConnection(fn);

it("assigns a qualified substitute and can undo it", async () => {
  const [cls, sub] = await firstWith(true);
  const change = await onConn((c) => assignSubstitute(c, cls.timetable_id, sub));
  expect(change).toMatchObject({ old_faculty_id: cls.faculty_id, new_faculty_id: sub, teaches_added: false, academic_year: TEST_YEAR });
  expect(await facultyOf(cls.timetable_id)).toBe(sub);
  expect(await callProcedure(pool(), "sp_list_clashes", [TEST_YEAR])).toEqual([]); // still clash-free
  expect(await callProcedure(pool(), "sp_hours_coverage", [TEST_YEAR])).toEqual([]);

  await onConn((c) => revertSubstitution(c, change));
  expect(await facultyOf(cls.timetable_id)).toBe(cls.faculty_id);
});

it("refuses a busy faculty member and changes nothing", async () => {
  const rows = await classes();
  const a = rows[0];
  const b = rows.find((r) => r.slot_id === a.slot_id && r.faculty_id !== a.faculty_id)!;
  await expect(onConn((c) => assignSubstitute(c, a.timetable_id, b.faculty_id))).rejects.toThrow(/already teaches/);
  expect(await facultyOf(a.timetable_id)).toBe(a.faculty_id);
});

it("needs a Teaches row for an unqualified substitute", async () => {
  const [cls, sub] = await firstWith(false);
  await expect(onConn((c) => assignSubstitute(c, cls.timetable_id, sub))).rejects.toThrow(/not listed in Teaches/);
  expect(await facultyOf(cls.timetable_id)).toBe(cls.faculty_id);
  expect(await teaches(sub, cls.course_id)).toBe(false);

  const change = await onConn((c) => assignSubstitute(c, cls.timetable_id, sub, { addTeaches: true }));
  expect(change.teaches_added).toBe(true);
  expect(await teaches(sub, cls.course_id)).toBe(true);
  expect(await facultyOf(cls.timetable_id)).toBe(sub);

  await onConn((c) => revertSubstitution(c, change)); // gives the class back AND removes the Teaches row
  expect(await facultyOf(cls.timetable_id)).toBe(cls.faculty_id);
  expect(await teaches(sub, cls.course_id)).toBe(false);
});

it("undo is all or nothing when the added Teaches row is in use", async (ctx) => {
  // if the substitute was meanwhile given a second class of that course, the Teaches row cannot be
  // dropped (FK RESTRICT): the undo must fail as a whole, changing nothing
  const [cls, sub] = await firstWith(false);
  const change = await onConn((c) => assignSubstitute(c, cls.timetable_id, sub, { addTeaches: true }));
  let other: Row | undefined;
  for (const r of await classes()) {
    if (r.course_id !== cls.course_id || r.timetable_id === cls.timetable_id || r.faculty_id === sub) continue;
    if ((await freeFaculty(r, true)) === null) continue;
    const subBusy = await query(pool(), "SELECT 1 AS x FROM Timetable WHERE academic_year = ? AND slot_id = ? AND faculty_id = ?",
      [TEST_YEAR, r.slot_id, sub]);
    if (!subBusy.length) {
      other = r;
      break;
    }
  }
  if (!other) return ctx.skip("no second class of that course where the substitute is free");
  await onConn((c) => assignSubstitute(c, other.timetable_id, sub)); // now qualified, no Teaches row added
  const err = await onConn((c) => revertSubstitution(c, change)).catch((e) => e);
  expect(err).toBeInstanceOf(SubstitutionError);
  expect(err.message).toMatch(/still used/);
  expect(await facultyOf(cls.timetable_id)).toBe(sub); // rolled back: nothing changed
  expect(await teaches(sub, cls.course_id)).toBe(true);
});

describe("bad requests are explained", () => {
  it.each(["unknown class", "unknown faculty", "same faculty"])("%s", async (kind) => {
    const cls = (await classes())[0];
    const [tid, fac, words] = {
      "unknown class": [999_999_999, 1, "no saved class"],
      "unknown faculty": [cls.timetable_id, 999_999, "unknown faculty"],
      "same faculty": [cls.timetable_id, cls.faculty_id, "already teaches this class"],
    }[kind] as [number, number, string];
    const err = await onConn((c) => assignSubstitute(c, tid, fac)).catch((e) => e);
    expect(err).toBeInstanceOf(SubstitutionError);
    expect(err.message).toContain(words);
  });
});
