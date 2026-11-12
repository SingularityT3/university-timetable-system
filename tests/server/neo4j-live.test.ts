/**
 * Tests against a RUNNING Neo4j whose graph was loaded by `npm run etl`. They only READ,
 * except the unavailability tests: those create their own UNAVAILABLE_AT mark and always
 * delete it again. If Neo4j is down or the graph is empty they skip themselves.
 */
import { afterAll, describe, expect, it } from "vitest";
import { pool, query } from "@/lib/server/db";
import * as E from "@/lib/server/etl";
import * as NQ from "@/lib/server/neo4j";
import { buildConflictGraph } from "@/lib/server/utils";
import { neo4jSkipReason } from "./neo4j-fixtures";
import { realYear } from "./helpers";

const skip = await neo4jSkipReason();
if (skip) console.warn(`skipping the live Neo4j tests: ${skip}`);
afterAll(NQ.closeDriver);

const one = async (sql: string, params: unknown[] = []) => Number((await query(pool(), sql, params))[0].v);

/** A slot this faculty member has no mark on (so the test owns the mark it makes). */
async function freeMark(facultyId: number): Promise<number> {
  const taken = new Set((await NQ.listUnavailability(facultyId)).map((m) => m.slot_id));
  for (let s = 48; s > 0; s--) if (!taken.has(s)) return s;
  throw new Error("every slot is marked");
}

/** Run fn with a session on the shared driver. */
async function withSession<T>(fn: (s: E.EtlSession) => Promise<T>): Promise<T> {
  const s = (await NQ.getDriver()).session({ database: NQ.neo4jSettings().database });
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

describe.skipIf(!!skip)("live Neo4j", () => {
  it("graph counts match MySQL for every year in the graph", async () => {
    const problems = await withSession(async (s) => {
      const years = [...new Set([realYear(), ...(await E.graphYears(s))])].sort();
      return E.compareCounts(await E.expectedCounts(pool(), years), await E.actualCounts(s));
    });
    expect(problems, "graph differs from MySQL: re-run `npm run etl`").toEqual([]);
  });

  it("derived conflicts equal the SQL definition", async () => {
    for (const [course, neighbours] of await buildConflictGraph(pool())) {
      const got = Object.fromEntries((await NQ.courseConflictNeighbours(course)).map((r) => [r.course_id, r.shared_count]));
      expect(got, course).toEqual(Object.fromEntries(neighbours));
    }
  });

  it("the workload total equals the saved classes", async () => {
    const inMysql = await one("SELECT COUNT(*) v FROM Timetable WHERE academic_year = ?", [realYear()]);
    expect((await NQ.facultyWorkloadRanking(realYear())).reduce((a, r) => a + r.periods, 0)).toBe(inMysql);
  });

  it("the absence plan counts every class of the teacher, and candidates are free", async () => {
    const y = realYear();
    const mysqlN = await one("SELECT COUNT(*) v FROM Timetable WHERE academic_year = ? AND faculty_id = 1", [y]);
    const plan = await NQ.facultyAbsencePlan(1, y);
    expect(plan.summary.classes_affected).toBe(mysqlN);
    expect(plan.classes.length).toBe(mysqlN);
    for (const c of plan.classes) {
      expect(["COVERABLE", "NEEDS_TEACHES", "UNCOVERED"]).toContain(c.status);
      for (const s of c.substitutes) {
        const busy = await one("SELECT COUNT(*) v FROM Timetable t JOIN Timetable m ON m.slot_id = t.slot_id " +
          "WHERE m.timetable_id = ? AND t.faculty_id = ? AND t.academic_year = ?", [c.timetable_id, s.candidate_id, y]);
        expect(busy).toBe(0);
      }
    }
  });

  it("free rooms are exactly the unbooked rooms", async () => {
    const y = realYear();
    const [{ slot_id: slot }] = await query(pool(), "SELECT slot_id FROM TimeSlot WHERE day_of_week = 'MON' AND period_no = 1");
    const booked = new Set((await query(pool(), "SELECT room_id FROM Timetable WHERE academic_year = ? AND slot_id = ?", [y, slot]))
      .map((r) => r.room_id));
    const lecture = (await query(pool(), "SELECT room_id FROM Classroom WHERE room_type = 'LECTURE' AND capacity >= 60"))
      .map((r) => r.room_id as number);
    const got = (await NQ.freeRooms("MON", 1, 60, "LECTURE", y)).map((r) => r.room_id as number);
    expect(got.sort()).toEqual(lecture.filter((r) => !booked.has(r)).sort());
  });

  it("finds the shortest path between connected faculty, and none for isolated ones", async () => {
    const far = await NQ.facultyShortestPath(1, 11); // CSE -> ECE, linked by the cross-department teachers
    expect(far.connected).toBe(true);
    expect([far.path[0].kind, far.path.at(-1)!.kind]).toEqual(["Faculty", "Faculty"]);
    expect(far.hops).toBe(far.path.length - 1);
    expect((await NQ.facultyShortestPath(1, 17)).connected).toBe(false); // Mechanical has no cross-department link
  });

  it("the ripple flags a section clash", async () => {
    // moving one class of a section into the slot of another class of the SAME section must clash
    const rows = await query(pool(), "SELECT t.timetable_id, ts.day_of_week d, ts.period_no p FROM Timetable t " +
      "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = ? AND t.section_id = 1 ORDER BY ts.slot_id LIMIT 2",
      [realYear()]);
    if (rows.length < 2) return; // section 1 has fewer than two classes saved
    const [a, b] = rows;
    const r = await NQ.moveClassRipple(a.timetable_id, b.d, b.p);
    expect(r.free_move).toBe(false);
    const hit = r.clashes.find((c) => c.clash_timetable_id === b.timetable_id)!;
    expect(hit.clash_types).toContain("SECTION");
    expect(r.students_displaced).toBeGreaterThanOrEqual(12);
  });

  it("creates, updates and deletes an unavailability mark", async () => {
    const fid = 19;
    const slot = await freeMark(fid);
    try {
      const made = await NQ.setUnavailability(fid, slot, "  Conference  ");
      expect([made.faculty_id, made.slot_id, made.reason]).toEqual([fid, slot, "Conference"]);
      await NQ.setUnavailability(fid, slot, "Medical leave"); // MERGE: update, not a second mark
      const mine = (await NQ.listUnavailability(fid)).filter((m) => m.slot_id === slot);
      expect(mine.map((m) => m.reason)).toEqual(["Medical leave"]);
      expect(mine[0].updated_at).toBeTruthy();
      expect((await NQ.listUnavailability()).some((m) => m.faculty_id === fid && m.slot_id === slot)).toBe(true);
      await expect(NQ.setUnavailability(fid, 10_000, "no such slot")).rejects.toBeInstanceOf(NQ.NotFoundError);
    } finally {
      expect(await NQ.deleteUnavailability(fid, slot)).toBe(1);
    }
    expect(await NQ.deleteUnavailability(fid, slot)).toBe(0);
    expect((await NQ.listUnavailability(fid)).every((m) => m.slot_id !== slot)).toBe(true);
  });

  it("the substitute finder skips a colleague marked unavailable", async () => {
    const y = realYear();
    const rows = await NQ.substituteFinder(1, y);
    if (!rows.length) return; // faculty 1 has no substitute candidates
    const [cls, cand] = [rows[0].timetable_id, rows[0].candidate_id];
    const [{ slot_id: slot }] = await query(pool(), "SELECT slot_id FROM Timetable WHERE timetable_id = ?", [cls]);
    expect((await NQ.listUnavailability(cand)).every((m) => m.slot_id !== slot)).toBe(true); // so the mark below is ours
    try {
      await NQ.setUnavailability(cand, slot, "test: unavailable");
      const after = await NQ.substituteFinder(1, y);
      expect(after.some((r) => r.timetable_id === cls && r.candidate_id === cand)).toBe(false);
      expect(after.length).toBe(rows.length - 1); // nothing else changed
    } finally {
      await NQ.deleteUnavailability(cand, slot);
    }
    expect((await NQ.substituteFinder(1, y)).some((r) => r.timetable_id === cls && r.candidate_id === cand)).toBe(true);
  });

  it("browses nodes and their neighbours", async () => {
    const nFaculty = Number((await query(pool(), "SELECT COUNT(*) AS n FROM Faculty"))[0].n);
    expect((await NQ.browseNodes("Faculty", null, 500)).length).toBe(nFaculty);
    const rooms = await NQ.browseNodes("Classroom", "lab", 500);
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms.every((r) => r.name.toLowerCase().includes("lab"))).toBe(true);
    const slots = await NQ.browseNodes("TimeSlot", "MON P1", 1);
    expect(slots[0].name).toBe("MON P1"); // integer properties stay integers (not "MON P1.0")
    const [fac] = await NQ.browseNodes("Faculty", null, 1);
    const nb = await NQ.nodeNeighbours("Faculty", fac.id, 500);
    expect(nb.length).toBe(fac.degree);
    expect(nb.find((r) => r.relationship === "WORKS_IN")).toMatchObject({ relationship: "WORKS_IN", direction: "OUT", label: "Department" });
  });
});
