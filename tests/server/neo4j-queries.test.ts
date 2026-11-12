/**
 * The Cypher query file, the query wrappers' own logic and the Neo4j settings.
 * No server: the reads/writes are stood in for.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "neo4j-driver";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as NQ from "@/lib/server/neo4j";
import type { Row } from "@/lib/server/db";

const EXPECTED_QUERIES = [
  "impact_analysis", "substitute_finder", "most_conflicted_courses", "free_rooms", "heaviest_day_students",
  "faculty_shortest_path", "faculty_workload", "move_class_ripple", "cross_department_teaching",
  "course_conflict_neighbours", "node_counts", "relationship_counts", "node_browser", "node_neighbours",
  "faculty_unavailability", "set_unavailability", "delete_unavailability",
].sort();

/** Replace the server calls; `rows(name, params)` answers both reads and writes. */
function standIn(rows: (name: string, params: Record<string, unknown>) => Row[]) {
  const calls: [string, Record<string, unknown>][] = [];
  const answer = async (name: string, params: Record<string, unknown> = {}) => (calls.push([name, { ...params }]), rows(name, params));
  vi.spyOn(NQ.io, "read").mockImplementation(answer);
  vi.spyOn(NQ.io, "write").mockImplementation(answer);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Cypher query file", () => {
  it("loads every documented query, without the trailing ';'", () => {
    const qs = NQ.queries();
    expect(Object.keys(qs).sort()).toEqual(EXPECTED_QUERIES);
    for (const q of Object.values(qs)) expect(q.trim() && !q.trimEnd().endsWith(";")).toBeTruthy();
  });

  it("every wrapper passes exactly the parameters its query uses", async () => {
    const calls = standIn((name) => (name === "delete_unavailability" ? [{ deleted: 0 }] : name === "set_unavailability" ? [{}] : []));
    await NQ.impactAnalysis(1, "2026-2027", "mon");
    await NQ.substituteFinder(1);
    await NQ.mostConflictedCourses();
    await NQ.freeRooms("MON", 1, 60, "lecture");
    await NQ.heaviestDayStudents();
    await NQ.facultyShortestPath(1, 11);
    await NQ.facultyWorkloadRanking();
    await NQ.crossDepartmentTeaching();
    await NQ.courseConflictNeighbours("CS301");
    await NQ.nodeCounts();
    await NQ.relationshipCounts();
    await NQ.browseNodes("Faculty", "dr");
    await NQ.nodeNeighbours("Course", "CS301");
    await NQ.listUnavailability(1);
    await NQ.setUnavailability(1, 5, "conference");
    await NQ.deleteUnavailability(1, 5);
    await expect(NQ.moveClassRipple(1, "FRI", 8)).rejects.toBeInstanceOf(NQ.NotFoundError);
    expect([...new Set(calls.map(([n]) => n))].sort()).toEqual(EXPECTED_QUERIES);
    for (const [name, params] of calls) {
      const used = new Set([...NQ.queries()[name].matchAll(/\$(\w+)/g)].map((m) => m[1]));
      expect([...used].sort(), name).toEqual(Object.keys(params).sort());
    }
  });

  it("the graph CRUD wrappers validate their input", async () => {
    const calls = standIn(() => []);
    expect(() => NQ.browseNodes("Faculty; MATCH (n) DETACH DELETE n")).toThrow(NQ.InputError); // labels: whitelist only
    expect(() => NQ.nodeNeighbours("Faculty", "abc")).toThrow(NQ.InputError); // Faculty keys are integers
    await expect(NQ.setUnavailability(1, 5, "x".repeat(NQ.MAX_REASON + 1))).rejects.toBeInstanceOf(NQ.InputError);
    await expect(NQ.setUnavailability(1, 999, "unknown slot")).rejects.toBeInstanceOf(NQ.NotFoundError); // no row back
    await NQ.browseNodes("Course", "   ", 10_000);
    await NQ.nodeNeighbours("Course", 301);
    await NQ.nodeNeighbours("TimeSlot", "7");
    const reads = calls.filter(([n]) => n !== "set_unavailability").map(([, p]) => p);
    expect(reads[0]).toEqual({ label: "Course", search: null, limit: 500 });
    expect(reads[1].key).toBe("301");
    expect(reads[2].key).toBe(7);
  });

  it("sends whole numbers as Cypher integers (LIMIT needs them) and keeps other values", () => {
    const p = NQ.toCypher({ limit: 5, ratio: 0.5, rows: [{ id: 2, name: "x" }], none: null }) as Row;
    expect(p.limit.toNumber()).toBe(5);
    expect(p.ratio).toBe(0.5);
    expect(p.rows[0].id.toNumber()).toBe(2);
    expect([p.rows[0].name, p.none]).toEqual(["x", null]);
  });
});

describe("query logic outside Cypher", () => {
  it("absence plan: statuses and students per distinct section", async () => {
    standIn((name) =>
      name === "impact_analysis"
        ? [1, 2, 3, 4].map((t) => ({ timetable_id: t, section_id: [1, 2, 1, 3][t - 1], students: 12 }))
        : [{ timetable_id: 1, fit: "QUALIFIED" }, { timetable_id: 1, fit: "RELATED" }, { timetable_id: 2, fit: "RELATED" }]);
    const plan = await NQ.facultyAbsencePlan(1);
    expect(plan.classes.map((c) => c.status)).toEqual(["COVERABLE", "NEEDS_TEACHES", "UNCOVERED", "UNCOVERED"]);
    expect(plan.summary.sections_affected).toBe(3);
    expect(plan.summary.students_affected).toBe(36); // section 1 counted once
  });

  it("ranking ties, an unconnected path and a free move", async () => {
    standIn((name) => ({
      faculty_workload: [{ periods: 10 }, { periods: 10 }, { periods: 8 }, { periods: 0 }],
      faculty_shortest_path: [],
      move_class_ripple: [{ moved_timetable_id: 7, moved_course: "C", moved_section: "S", from_day: "MON", from_period: 1,
        to_day: "FRI", to_period: 8, clash_timetable_id: null, students_displaced: 0 }],
    })[name]!);
    expect((await NQ.facultyWorkloadRanking()).map((r) => r.rank)).toEqual([1, 1, 2, 3]); // ties share a rank
    expect(await NQ.facultyShortestPath(1, 17)).toEqual({ connected: false, hops: null, path: [] });
    expect((await NQ.moveClassRipple(7, "FRI", 8)).free_move).toBe(true);
  });

  it.each([
    () => NQ.impactAnalysis(1, undefined, "XYZ"),
    () => NQ.freeRooms("MON", 1, 0, "gym"),
    () => NQ.facultyShortestPath(3, 3),
    () => NQ.freeRooms(null as unknown as string, 1),
  ])("rejects bad arguments early (%#)", async (call) => {
    standIn(() => []);
    await expect((async () => call())()).rejects.toBeInstanceOf(NQ.InputError);
  });
});

describe("settings and driver", () => {
  it("parses .env files (comments, quotes, empty values, = inside values)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-env-"));
    writeFileSync(join(dir, ".env"), '# comment\nA=1\nB = "two"\n\nC=\nnot a setting\nD=x=y\n');
    expect(NQ.readEnvFile(join(dir, ".env"))).toEqual({ A: "1", B: "two", C: "", D: "x=y" });
    expect(NQ.readEnvFile(join(dir, "missing.env"))).toEqual({});
  });

  it("describes the settings without showing the password, and flags overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-env-"));
    const f = join(dir, ".env");
    writeFileSync(f, "NEO4J_PASSWORD=file_password\n");
    const saved = process.env.NEO4J_PASSWORD;
    try {
      process.env.NEO4J_PASSWORD = "file_password";
      const text = NQ.describeNeo4jSettings(f).join("\n");
      expect(text).not.toContain("file_password");
      expect(text).toContain("13 chars");
      expect(text).toContain("source: .env file");
      process.env.NEO4J_PASSWORD = "other_password";
      expect(NQ.describeNeo4jSettings(f).join("\n")).toContain("OVERRIDING");
      process.env.NEO4J_PASSWORD = "";
      expect(NQ.describeNeo4jSettings(join(dir, "none.env")).join("\n")).toContain("NOT SET");
    } finally {
      process.env.NEO4J_PASSWORD = saved;
    }
  });

  it("drops a cached driver whose server went away, and reuses a live one", async () => {
    const fake = (up: boolean) => {
      const d = { closed: false, verifyConnectivity: async () => { if (!up) throw new Error("down"); }, close: async () => { d.closed = true; } };
      return d;
    };
    await NQ.closeDriver();
    const dead = fake(true);
    vi.spyOn(NQ.io, "createDriver").mockReturnValueOnce(dead as unknown as Driver);
    expect(await NQ.getDriver()).toBe(dead);
    dead.verifyConnectivity = async () => { throw new Error("down"); }; // the server went away
    vi.spyOn(NQ.io, "createDriver").mockReturnValue(fake(false) as unknown as Driver);
    await expect(NQ.getDriver()).rejects.toThrow("down");
    expect(dead.closed).toBe(true);

    const fresh = fake(true);
    vi.spyOn(NQ.io, "createDriver").mockReturnValue(fresh as unknown as Driver);
    expect(await NQ.getDriver()).toBe(fresh);
    expect(await NQ.getDriver()).toBe(fresh); // reused while the server is up
    await NQ.closeDriver();
    expect(fresh.closed).toBe(true);
  });
});
