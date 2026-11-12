/**
 * The API route handlers (app/api/**), called directly with Next.js requests.
 *
 * Logins use the seeded demo users; their last_login is restored afterwards. Writes only touch
 * TEST_YEAR (substitution) or a Neo4j mark the test creates and deletes again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, query, type Row } from "@/lib/server/db";
import { appSecret, COOKIE, makeToken } from "@/lib/server/auth";
import * as etl from "@/lib/server/etl";
import { closeDriver } from "@/lib/server/neo4j";
import { DAY_NO, DAY_ORDER } from "@/lib/server/utils";
import { Client, login } from "./api-client";
import { realYear, saveTestYear, TEST_YEAR, wipeTestYear } from "./helpers";
import { neo4jSkipReason } from "./neo4j-fixtures";

const ADMIN_ONLY: [string, string, unknown][] = [
  ["POST", "/generator", { dry_run: true }],
  ["POST", "/etl", { year: TEST_YEAR }],
  ["POST", "/substitutions", { timetable_id: 1, faculty_id: 2 }],
  ["POST", "/substitutions/undo", { change: {
    timetable_id: 1, academic_year: TEST_YEAR, course_id: "X", section_id: 1, slot_id: 1,
    old_faculty_id: 1, old_faculty: "a", new_faculty_id: 2, new_faculty: "b", teaches_added: false } }],
  ["PUT", "/graph/unavailability", { faculty_id: 1, slot_id: 1, reason: "x" }],
  ["DELETE", "/graph/unavailability?faculty_id=1&slot_id=1", undefined],
];

const count = async (sql: string, params: unknown[]) => Number((await query(pool(), sql, params))[0].n);
const graphSkip = await neo4jSkipReason();

let lastLogins: Row[];
let admin: Client;
let faculty: Client;
let year: string;

beforeAll(async () => {
  // logging in stamps AppUser.last_login: put the old values back afterwards
  lastLogins = await query(pool(), "SELECT user_id, last_login FROM AppUser");
  [admin, faculty, year] = [await login("admin", "admin123"), await login("faculty1", "faculty123"), realYear()];
});
afterAll(async () => {
  for (const r of lastLogins) await query(pool(), "UPDATE AppUser SET last_login = ? WHERE user_id = ?", [r.last_login, r.user_id]);
  await closeDriver();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("login sets an httpOnly session cookie", async () => {
    const r = await new Client().post("/auth/login", { username: "faculty1", password: "faculty123" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.user).sort()).toEqual(["faculty_id", "faculty_name", "role", "user_id", "username"]);
    expect([r.body.user.username, r.body.user.role, r.body.user.faculty_id]).toEqual(["faculty1", "faculty", 1]);
    const cookie = r.headers.get("set-cookie")!.toLowerCase();
    expect(cookie.startsWith(`${COOKIE}=`)).toBe(true);
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
    expect(cookie).toContain("max-age=28800");
  });

  it.each([["admin", "wrong"], ["nobody", "admin123"], ["", ""]])("a bad login (%s / %s) is 401", async (username, password) => {
    const c = new Client();
    const r = await c.post("/auth/login", { username, password });
    expect(r.status).toBe(401);
    expect(typeof r.body.detail).toBe("string");
    expect(c.cookies.has(COOKIE)).toBe(false);
  });

  it("a malformed login body is 422 with a list detail [{loc, msg, type}]", async () => {
    const r = await new Client().post("/auth/login", { username: "admin" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toEqual([{ type: "missing", loc: ["body", "password"], msg: "Field required", input: { username: "admin" } }]);
  });

  it("/auth/me returns the logged-in user", async () => {
    expect((await admin.get("/auth/me")).body.role).toBe("admin");
    const me = (await faculty.get("/auth/me")).body;
    expect(me.role).toBe("faculty");
    expect(me.faculty_id).toBe(1);
    expect(me.faculty_name).toBeTruthy();
  });

  it.each(["/auth/me", "/meta", "/timetable?id=1", "/stats", "/graph/nodes?label=Faculty"])("%s needs a login", async (path) => {
    const c = new Client();
    expect((await c.get(path)).status).toBe(401);
    c.cookies.set(COOKIE, "forged.token");
    expect((await c.get(path)).status).toBe(401);
  });

  it("an expired session is 401", async () => {
    const user = { user_id: (await admin.get("/auth/me")).body.user_id, role: "admin" as const };
    const c = new Client();
    c.cookies.set(COOKIE, makeToken(user, appSecret(), -1));
    expect((await c.get("/auth/me")).status).toBe(401);
    c.cookies.set(COOKIE, makeToken(user, appSecret()));
    expect((await c.get("/auth/me")).status).toBe(200);
  });

  it("logout clears the cookie", async () => {
    const c = await login("faculty2", "faculty123");
    const r = await c.post("/auth/logout");
    expect(r.status).toBe(204);
    expect(r.headers.get("set-cookie")).toContain(`${COOKIE}=`);
    expect((await c.get("/auth/me")).status).toBe(401);
  });

  it.each(ADMIN_ONLY)("faculty gets 403 on %s %s", async (method, path, body) => {
    expect((await faculty.request(method, path, body)).status).toBe(403);
  });

  it("/health needs no login", async () => {
    const r = await new Client().get("/health");
    expect(r.status).toBe(200);
    expect(r.body.mysql).toBe(true);
    expect(typeof r.body.neo4j).toBe("boolean");
  });

  it("unknown API paths are a JSON 404", async () => {
    const r = await new Client().get("/nope/at/all");
    expect([r.status, r.body]).toEqual([404, { detail: "Not Found" }]);
  });
});

describe("read routes", () => {
  it("/meta", async () => {
    const m = (await faculty.get("/meta")).body;
    expect(m.default_year).toBe(year);
    expect(m.years).toContain(year);
    expect(m.years).toEqual([...m.years].sort().reverse());
    expect(m.days).toEqual([...DAY_ORDER]);
    for (const key of ["sections", "faculty", "rooms", "courses", "slots"]) {
      expect(m[key].length, key).toBeGreaterThan(0);
      expect(m[key][0], key).toHaveProperty("id");
      expect(m[key][0], key).toHaveProperty("label");
    }
    expect(m.faculty[0].name).toBeTruthy();
    expect(m.slots[0].start_time).toBe("08:30");
    expect(Object.keys(m.neo4j).sort()).toEqual(["detail", "ok"]);
    expect(Object.keys(m.counts).sort()).toEqual([...m.years].sort());
  });

  it.each([["section", "faculty_name"], ["faculty", "section"], ["room", "section"]])("/timetable view=%s", async (view, second) => {
    const r = (await faculty.get(`/timetable?view=${view}&id=1&year=${year}`)).body;
    const col = { section: "section_id", faculty: "faculty_id", room: "room_id" }[view];
    const n = await count(`SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ? AND ${col} = ?`, [year, 1]);
    expect(r.metrics.periods).toBe(n);
    expect(r.rows.length).toBe(n);
    expect(r.metrics.days).toBe(new Set(r.rows.map((x: Row) => x.day_of_week)).size);
    const order = r.rows.map((x: Row) => DAY_NO[x.day_of_week] * 100 + x.period_no);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.rows[0].start_time).toMatch(/^\d{2}:\d{2}$/);
    expect(r.grid.rows.filter((x: Row) => x.kind === "break").map((x: Row) => x.label)).toEqual(["Lunch"]);
    const classes: Row[] = r.grid.rows.flatMap((row: Row) => Object.values(row.cells).flat());
    expect(classes.length).toBe(n);
    for (const c of classes) {
      expect(c.lines.length).toBe(3);
      expect(c.lines[0]).toBe(c.course_id);
      expect(["THEORY", "LAB"]).toContain(c.course_type);
      if (second === "faculty_name") expect(c.lines[1]).toBe(c.faculty_name);
      else expect(c.lines[1].endsWith(`Sem ${c.semester} ${c.section_name}`)).toBe(true);
    }
  });

  it("/timetable rejects an unknown view, a bad id and a long year", async () => {
    const r = await faculty.get("/timetable?view=student&id=1");
    expect([r.status, r.body.detail]).toEqual([400, "view must be one of ['faculty', 'room', 'section']"]);
    const bad = await faculty.get("/timetable?id=abc&year=2026-20270");
    expect(bad.status).toBe(422);
    expect(bad.body.detail.map((d: Row) => d.loc)).toEqual([["query", "id"], ["query", "year"]]);
  });

  it("/free-blocks", async () => {
    const rows = (await faculty.get(`/free-blocks?kind=faculty&id=1&year=${year}`)).body;
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["day_of_week", "end_period", "end_time", "length", "start_period", "start_time"]);
    expect(rows[0].start_time).toMatch(/^\d{2}:\d{2}$/);
    expect((await faculty.get("/free-blocks?kind=student&id=1")).status).toBe(400);
  });

  it("/clashes", async () => {
    const r = (await faculty.get(`/clashes?year=${year}`)).body;
    const n = await count("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [year]);
    expect(r).toEqual({ classes: n, clashes: [], gaps: [] });
  });

  it("/clashes/check: faculty may check; a class in a slot its section already uses is rejected", async () => {
    const [t] = await query(pool(), "SELECT * FROM Timetable WHERE academic_year = ? ORDER BY timetable_id LIMIT 1", [year]);
    const r = (await faculty.post("/clashes/check", {
      year, section_id: t.section_id, course_id: t.course_id, faculty_id: t.faculty_id, room_id: t.room_id, slot_id: t.slot_id,
    })).body;
    expect(r.accepted).toBe(false);
    expect(r.hard_broken).toBe(r.results.filter((x: Row) => x.hard && !x.ok).length);
    expect(r.hard_broken).toBeGreaterThanOrEqual(3);
    expect(Object.keys(r.results[0]).sort()).toEqual(["detail", "hard", "ok", "rule"]);
  });

  it("/sections/{id}/classes", async () => {
    const rows = (await faculty.get(`/sections/1/classes?year=${year}`)).body;
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["course_id", "day_of_week", "faculty", "period_no", "timetable_id"]);
    expect((await faculty.get("/sections/x/classes")).status).toBe(422);
  });

  it("/stats", async () => {
    const s = (await faculty.get(`/stats?year=${year}`)).body;
    expect(Object.keys(s).sort()).toEqual(
      ["by_day", "by_period", "classes", "departments", "graph", "kinds", "rooms", "section_load", "workload"]);
    const total = (rows: Row[], k = "classes") => rows.reduce((a, r) => a + Number(r[k]), 0);
    expect(total(s.by_day)).toBe(s.classes);
    expect(total(s.by_period)).toBe(s.classes);
    expect(s.by_day.map((r: Row) => r.day)).toEqual(DAY_ORDER.filter((d) => s.by_day.some((r: Row) => r.day === d)));
    expect(total(s.departments, "total_periods")).toBe(s.classes);
    expect(typeof s.rooms[0].utilization_pct).toBe("number");
    expect([["bridges", "conflicted"], ["error"]]).toContainEqual(Object.keys(s.graph).sort());
  });
});

describe("admin actions", () => {
  it("a generator dry run changes nothing", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [year]);
    const r = await admin.post("/generator", { year, dry_run: true, time_limit: 20 });
    expect(r.status).toBe(200);
    const g = r.body;
    expect([g.status, g.committed, g.note]).toEqual(["COMPLETE", false, "dry run"]);
    expect(g.placed).toBe(g.required);
    expect(g.required).toBeGreaterThan(0);
    expect(g.report).toContain("Academic year");
    expect(g.max_fac_consec).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [year])).toBe(before);
  });

  it("the generator validates the time limit", async () => {
    const r = await admin.post("/generator", { dry_run: true, time_limit: 500 });
    expect(r.status).toBe(422);
    expect(r.body.detail[0]).toMatchObject({ loc: ["body", "time_limit"], msg: "Input should be less than or equal to 120" });
  });

  it("assigns a substitute and undoes it (graph refresh stubbed)", async () => {
    const refreshed: [string | null, etl.EtlOptions][] = [];
    vi.spyOn(etl, "runEtl").mockImplementation(async (y, opts = {}) => {
      refreshed.push([y ?? null, opts]);
      return { ok: true, problems: [], expected: { nodes: {}, relationships: {} }, actual: { nodes: {}, relationships: {} } };
    });
    await saveTestYear();
    try {
      const pick = await query(pool(), "SELECT t.timetable_id, t.faculty_id AS old, th.faculty_id AS new FROM Timetable t " +
        "JOIN Teaches th ON th.course_id = t.course_id AND th.faculty_id <> t.faculty_id " +
        "WHERE t.academic_year = ? AND NOT EXISTS (SELECT 1 FROM Timetable b WHERE b.academic_year = t.academic_year " +
        "AND b.slot_id = t.slot_id AND b.faculty_id = th.faculty_id) ORDER BY t.timetable_id LIMIT 1", [TEST_YEAR]);
      expect(pick.length, "no qualified free colleague in the generated TEST_YEAR timetable").toBe(1);
      const { timetable_id: tid, old, new: sub } = pick[0];
      const facultyOf = async () => (await query(pool(), "SELECT faculty_id FROM Timetable WHERE timetable_id = ?", [tid]))[0].faculty_id;

      const r = await admin.post("/substitutions", { timetable_id: tid, faculty_id: sub });
      expect(r.status).toBe(200);
      const change = r.body.change;
      expect([r.body.graph_problem, change.teaches_added]).toEqual([null, false]);
      expect(await facultyOf()).toBe(sub);
      expect(refreshed.map(([y]) => y)).toEqual([TEST_YEAR]); // graph refresh asked
      expect(refreshed[0][1].role).toBe("admin");

      const again = await admin.post("/substitutions", { timetable_id: tid, faculty_id: sub });
      expect(again.status).toBe(409);
      expect(again.body.detail).toContain("already teaches");

      const undo = await admin.post("/substitutions/undo", { change });
      expect(undo.status).toBe(200);
      expect(await facultyOf()).toBe(old);
      expect(undo.body.change.new_faculty_id).toBe(old);
    } finally {
      await wipeTestYear();
    }
  });
});

describe("Neo4j routes", () => {
  it("Neo4j down gives 503", async () => {
    const saved = { uri: process.env.NEO4J_URI, password: process.env.NEO4J_PASSWORD };
    await closeDriver();
    process.env.NEO4J_URI = "bolt://127.0.0.1:1";
    process.env.NEO4J_PASSWORD ||= "not-used"; // configured but unreachable (CI's MariaDB job sets no password)
    try {
      const r = await admin.get("/graph/nodes?label=Faculty");
      expect(r.status).toBe(503);
      expect(r.body.detail).toContain("Neo4j is not reachable");
      expect((await admin.get("/absence?faculty_id=1")).status).toBe(503);
      expect((await admin.get("/meta")).body.neo4j).toEqual({ ok: false, detail: "ServiceUnavailable" });
      expect((await admin.get("/stats")).body.graph.error).toContain("Neo4j is not reachable");
    } finally {
      for (const [name, value] of [["NEO4J_URI", saved.uri], ["NEO4J_PASSWORD", saved.password]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await closeDriver();
    }
  });

  describe.skipIf(!!graphSkip)("with the graph loaded", () => {
    it("graph browser", async () => {
      const nodes = (await faculty.get("/graph/nodes?label=Course&search=cs3&limit=5")).body;
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.length).toBeLessThanOrEqual(5);
      for (const n of nodes) expect(`${n.id} ${n.name}`.toLowerCase()).toContain("cs3");
      expect(Object.keys(nodes[0]).sort()).toEqual(["degree", "id", "name", "properties"]);
      const nb = (await faculty.get(`/graph/neighbours?label=Course&key=${nodes[0].id}`)).body;
      expect(Object.keys(nb[0]).sort()).toEqual(["direction", "key", "label", "name", "properties", "relationship"]);
      expect((await faculty.get("/graph/nodes?label=Nope")).status).toBe(400);
      expect((await faculty.get("/graph/neighbours?label=Faculty&key=abc")).status).toBe(400);
      expect((await faculty.get("/graph/nodes?label=Faculty&limit=0")).status).toBe(422);
    });

    it("absence and ripple", async () => {
      const plan = (await faculty.get(`/absence?faculty_id=1&year=${year}&day=`)).body;
      for (const k of ["classes", "summary", "stale"]) expect(plan).toHaveProperty(k);
      expect(plan.stale).toBeNull();
      const [t] = await query(pool(), "SELECT timetable_id FROM Timetable WHERE academic_year = ? LIMIT 1", [year]);
      const r = (await faculty.get(`/ripple?timetable_id=${t.timetable_id}&day=FRI&period=8`)).body;
      expect(Object.keys(r).sort()).toEqual(["clashes", "free_move", "moved", "students_displaced"]);
      expect((await faculty.get("/ripple?timetable_id=-5&day=FRI&period=8")).status).toBe(404);
      expect((await faculty.get("/ripple?timetable_id=1&day=FRI&period=9")).status).toBe(422);
      expect((await faculty.get("/absence?faculty_id=1&day=XYZ")).status).toBe(400);
    });

    it("unavailability create / update / delete", async () => {
      const fid = 20;
      const taken = new Set((await admin.get(`/graph/unavailability?faculty_id=${fid}`)).body.map((m: Row) => m.slot_id));
      const slot = [...Array(48).keys()].map((i) => 48 - i).find((s) => !taken.has(s))!;
      let r;
      try {
        r = await admin.put("/graph/unavailability", { faculty_id: fid, slot_id: slot, reason: "API test" });
        expect([r.status, r.body.reason]).toEqual([200, "API test"]);
        expect(r.body.updated_at).toBeTruthy();
        await admin.put("/graph/unavailability", { faculty_id: fid, slot_id: slot, reason: "edited" });
        const mine = (await faculty.get(`/graph/unavailability?faculty_id=${fid}`)).body.filter((m: Row) => m.slot_id === slot);
        expect(mine.map((m: Row) => m.reason)).toEqual(["edited"]);
        expect((await faculty.get("/graph/unavailability")).body.some((m: Row) => m.slot_id === slot)).toBe(true);
        expect((await admin.put("/graph/unavailability", { faculty_id: fid, slot_id: slot, reason: "x".repeat(201) })).status).toBe(422);
        expect((await admin.put("/graph/unavailability", { faculty_id: -1, slot_id: slot })).status).toBe(404);
      } finally {
        r = await admin.delete(`/graph/unavailability?faculty_id=${fid}&slot_id=${slot}`);
      }
      expect(r.body).toEqual({ deleted: 1 });
      expect((await admin.delete(`/graph/unavailability?faculty_id=${fid}&slot_id=${slot}`)).body).toEqual({ deleted: 0 });
    });
  });
});
