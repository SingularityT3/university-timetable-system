/**
 * sql/05_advanced_sql.sql: the stored function, the CTE procedure and the recursive CTE.
 * Read-only against the real year, plus the empty throw-away year.
 */
import { afterAll, describe, expect, it } from "vitest";
import { callProcedure, pool, query, type Row } from "@/lib/server/db";
import { buildSlotLinks, DAY_NO } from "@/lib/server/utils";
import { realYear, TEST_YEAR, wipeTestYear } from "./helpers";

const db = () => pool();
const one = async (sql: string, params: unknown[] = []) => Number((await query(db(), sql, params))[0].n);
const allSlots = () => query(db(), "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot");

/** Blocks are disjoint, maximal, never cross lunch, and blocks + busy slots = every slot. */
async function checkFreeBlocks(year: string, kind: "FACULTY" | "ROOM", id: number, slots: Row[]): Promise<void> {
  const byKey = new Map(slots.map((s) => [`${s.day_of_week}|${s.period_no}`, s]));
  const { next, prev } = buildSlotLinks(slots);
  const col = kind === "FACULTY" ? "faculty_id" : "room_id";
  const busy = new Set((await query(db(), `SELECT slot_id FROM Timetable WHERE academic_year = ? AND ${col} = ?`, [year, id]))
    .map((r) => r.slot_id as number));
  const covered: number[] = [];
  for (const b of await callProcedure(db(), "sp_free_blocks", [year, kind, id])) {
    const ids: number[] = [];
    for (let p = b.start_period; p <= b.end_period; p++) ids.push(byKey.get(`${b.day_of_week}|${p}`)!.slot_id);
    expect(b.length).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(b.start_time).toBe(byKey.get(`${b.day_of_week}|${b.start_period}`)!.start_time);
    expect(b.end_time).toBe(byKey.get(`${b.day_of_week}|${b.end_period}`)!.end_time);
    for (let i = 0; i + 1 < ids.length; i++) expect(next.get(ids[i])).toBe(ids[i + 1]); // consecutive, no lunch inside
    const [before, after] = [prev.get(ids[0]), next.get(ids.at(-1)!)];
    expect(before === undefined || busy.has(before)).toBe(true); // maximal at the start
    expect(after === undefined || busy.has(after)).toBe(true); // ... and at the end
    covered.push(...ids);
  }
  expect(new Set(covered).size).toBe(covered.length); // disjoint
  expect(covered.filter((s) => busy.has(s))).toEqual([]);
  expect(new Set([...covered, ...busy]).size).toBe(slots.length);
}

afterAll(wipeTestYear);

describe("advanced SQL", () => {
  it("fn_faculty_load equals the count of timetable rows", async () => {
    const y = realYear();
    const rows = await query(db(), "SELECT f.faculty_id, fn_faculty_load(f.faculty_id, ?) AS fn, " +
      "(SELECT COUNT(*) FROM Timetable t WHERE t.faculty_id = f.faculty_id AND t.academic_year = ?) AS n FROM Faculty f", [y, y]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.fn)).toBe(Number(r.n));
    expect(await one("SELECT fn_faculty_load(1, 'no-year') AS n")).toBe(0);
  });

  it("sp_department_summary totals match the timetable", async () => {
    const y = realYear();
    const rows = await callProcedure(db(), "sp_department_summary", [y]);
    const classes = await one("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [y]);
    const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
    expect(rows.length).toBe(await one("SELECT COUNT(*) AS n FROM Department"));
    expect(sum("total_periods")).toBe(classes);
    expect(sum("classes_scheduled")).toBe(classes);
    expect(sum("faculty_count")).toBe(await one("SELECT COUNT(*) AS n FROM Faculty"));
    expect(sum("sections")).toBe(await one("SELECT COUNT(*) AS n FROM Section"));
    for (const r of rows) {
      const loads = (await query(db(), "SELECT fn_faculty_load(faculty_id, ?) AS n FROM Faculty WHERE dept_id = ?", [y, r.dept_id]))
        .map((x) => Number(x.n));
      expect(r.teaching_faculty).toBe(loads.filter((n) => n > 0).length);
      expect(Number(r.avg_load)).toBeCloseTo(loads.reduce((a, b) => a + b, 0) / loads.length, 2);
      expect(r.busiest_load).toBe(Math.max(...loads) || null);
    }
  });

  it("sp_free_blocks is right for every faculty member and room", async () => {
    const slots = await allSlots();
    for (const f of await query(db(), "SELECT faculty_id FROM Faculty")) await checkFreeBlocks(realYear(), "FACULTY", f.faculty_id, slots);
    for (const r of await query(db(), "SELECT room_id FROM Classroom")) await checkFreeBlocks(realYear(), "ROOM", r.room_id, slots);
  });

  it("the free blocks of an empty year are the half days", async () => {
    // nothing booked: each day splits into exactly two blocks at lunch (P1-P4, P5-P8 with the seed slots)
    await wipeTestYear();
    const slots = await allSlots();
    await checkFreeBlocks(TEST_YEAR, "ROOM", 1, slots);
    const blocks = await callProcedure(db(), "sp_free_blocks", [TEST_YEAR, "ROOM", 1]);
    const days = [...new Set(slots.map((s) => s.day_of_week as string))].sort((a, b) => DAY_NO[a] - DAY_NO[b]);
    expect(blocks.map((b) => [b.start_period, b.end_period])).toEqual(days.flatMap(() => [[1, 4], [5, 8]]));
    expect(blocks.map((b) => b.day_of_week)).toEqual(days.flatMap((d) => [d, d]));
  });

  it("sp_free_blocks rejects an unknown kind", async () => {
    await expect(callProcedure(db(), "sp_free_blocks", [realYear(), "STUDENT", 1])).rejects.toThrow("FACULTY or ROOM");
  });
});
