/** Pure helpers of lib/server/utils.ts. No database needed. */
import { describe, expect, it } from "vitest";
import {
  DAY_ORDER, buildSlotLinks, buildWeekGrid, deptCode, describeMysqlError, fmtTime, formatTable, toMinutes,
} from "@/lib/server/utils";

const PERIODS = [["08:30", "09:20"], ["09:20", "10:10"], ["10:25", "11:15"], ["11:15", "12:05"],
  ["13:00", "13:50"], ["13:50", "14:40"], ["14:55", "15:45"], ["15:45", "16:35"]];
const slots = () => DAY_ORDER.flatMap((day, d) => PERIODS.map(([s, e], i) =>
  ({ slot_id: d * 8 + i + 1, day_of_week: day, period_no: i + 1, start_time: s, end_time: e })));

describe("time helpers", () => {
  it("accept HH:MM and HH:MM:SS", () => {
    expect(toMinutes("08:30")).toBe(510);
    expect(toMinutes("08:30:00")).toBe(510);
    expect(fmtTime("15:45:00")).toBe("15:45");
    expect(() => toMinutes(12 as unknown as string)).toThrow(TypeError);
  });

  it("slot links break at lunch but not at tea", () => {
    const { next, prev } = buildSlotLinks(slots());
    expect(next.get(2)).toBe(3); // tea breaks (15 min) keep periods linked
    expect(next.get(6)).toBe(7);
    expect(next.has(4) || prev.has(5)).toBe(false); // lunch (P4 -> P5) breaks the chain
    expect(prev.get(3)).toBe(2);
  });
});

describe("week grid", () => {
  it("has 8 period rows, one Lunch row and the class in its cell", () => {
    const classes = [{ day_of_week: "MON", period_no: 1, course_id: "CS201", course_type: "THEORY", lines: ["CS201", "A"] }];
    const grid = buildWeekGrid(slots(), classes);
    expect(grid.days).toEqual([...DAY_ORDER]);
    expect(grid.rows.filter((r) => r.kind === "period")).toHaveLength(8);
    expect(grid.rows.filter((r) => r.kind === "break").map((r) => r.label)).toEqual(["Lunch"]);
    expect(grid.rows[0]).toMatchObject({ label: "P1", sub: "08:30 - 09:20" });
    expect(grid.rows[0].cells.MON[0].course_id).toBe("CS201");
    expect(grid.rows[4]).toEqual({ kind: "break", label: "Lunch", sub: "12:05 - 13:00", cells: {} });
  });
});

describe("describeMysqlError", () => {
  const err = (errno: number, sqlMessage: string) => Object.assign(new Error(sqlMessage), { errno, sqlMessage });
  it.each([
    [1062, "Duplicate entry '1-1-2026' for key 'Timetable.uq_room_slot'", "room"],
    [1062, "Duplicate entry for key 'uq_faculty_slot'", "faculty"],
    [1062, "Duplicate entry for key 'uq_section_slot'", "section"],
    [1452, "foreign key constraint fails (CONSTRAINT `fk_tt_teaches` FOREIGN KEY ...)", "Teaches"],
    [1451, "Cannot delete or update a parent row: a foreign key constraint fails (CONSTRAINT `fk_tt_teaches` ...)", "still used"],
    [5001, "Room capacity is less than section strength", "capacity"],
    [5002, "Course type does not match room type", "room type"],
    [9999, "something else", "9999"],
  ])("errno %i -> mentions %s", (errno, msg, expected) => {
    expect(describeMysqlError(err(errno, msg as string))).toContain(expected);
  });
});

describe("formatTable and deptCode", () => {
  it("render tables and department codes", () => {
    const out = formatTable([{ a: 1, b: ["x", "y"], c: null }, { a: 22, b: [], c: "z" }]);
    expect(out).toContain("x, y");
    expect(out.split("\n")[0].split(/\s+/)).toEqual(["a", "b", "c"]);
    expect(formatTable([])).toBe("(no rows)");
    expect(formatTable([{ a: 1 }, { a: 2 }, { a: 3 }], undefined, 2)).toMatch(/\.\.\. 1 more row\(s\)$/);
    expect(deptCode("Computer Science and Engineering")).toBe("CSE");
    expect(deptCode("Mechanical Engineering")).toBe("ME");
  });
});
