/**
 * Export MySQL (system of record) into Neo4j (graph analytics).
 *
 * IDEMPOTENT: every node and relationship is written with MERGE on its key. Order of work:
 *   1. constraints + indexes   (cypher/constraints.cypher, created FIRST)
 *   2. nodes                   Department, Faculty, Course, Section, Student, Classroom, TimeSlot
 *   3. static relationships    WORKS_IN, OFFERED_BY, BELONGS_TO, STUDIES_IN, TEACHES, ENROLLED_IN, TAKES
 *                              (relationships whose MySQL row was deleted are pruned)
 *   4. timetable               SCHEDULED_IN (one per Timetable row) + derived TEACHES_SECTION; the
 *                              year's old ones are deleted first, so a new timetable leaves no ghosts
 *   5. derived CONFLICTS_WITH  rebuilt inside Neo4j from TEACHES / ENROLLED_IN
 *                              (shared_count = shared faculty + shared students, as buildConflictGraph)
 *   6. verification            graph counts compared with expected counts from MySQL
 *
 * CLI (scripts/etl.ts):  npm run etl                      all academic years in Timetable
 *                        npm run etl -- --year 2026-2027
 *                        npm run etl -- --reset          wipe the graph first
 * The faculty unavailability marks (UNAVAILABLE_AT, made on the web app's Graph page) exist
 * only in Neo4j: a normal run keeps them, --reset deletes them too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ManagedTransaction } from "neo4j-driver";
import { query, withConnection, type Db, type Role, type Row } from "./db";
import { PROJECT_ROOT } from "./env";
import {
  closeDriver, getDriver, neo4jDownReason, neo4jSettings, nodeCounts, relationshipCounts, toCypher, type ReadSession,
} from "./neo4j";
import { buildConflictGraph, DAY_NO, deptCode, fmtTime } from "./utils";

export const BATCH_SIZE = 500;
export const CONSTRAINTS_FILE = join(PROJECT_ROOT, "cypher", "constraints.cypher");

/** What the ETL needs from a Neo4j session (tests pass a recording stand-in). */
export interface EtlSession extends ReadSession {
  executeWrite<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T>;
}
export type Log = (line: string) => void;
export interface Counts { nodes: Record<string, number>; relationships: Record<string, number> }
export interface EtlResult { expected: Counts; actual: Counts; problems: string[]; ok: boolean }

// ------------------------------------------------------------------ helpers
/** Split a .cypher file into statements: drop '//' comment lines, split on ';'. */
export function readStatements(path: string): string[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("//"));
  return lines.join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}

/** Run one write statement in its own transaction (retried by the driver). */
async function write(session: EtlSession, cypher: string, params: Record<string, unknown> = {}): Promise<void> {
  await session.executeWrite(async (tx) => {
    await tx.run(cypher, toCypher(params) as Record<string, unknown>);
  });
}

/** UNWIND `rows` into `cypher` in chunks of BATCH_SIZE; returns rows sent. */
export async function batched(session: EtlSession, cypher: string, rows: Row[], what: string, log: Log): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) await write(session, cypher, { rows: rows.slice(i, i + BATCH_SIZE) });
  log(`  ${what.padEnd(28)} ${String(rows.length).padStart(6)} rows`);
  return rows.length;
}

// ----------------------------------------------------------- Cypher (writes)
export const Q_NODES: Record<string, string> = {
  Department: `UNWIND $rows AS row
MERGE (n:Department {dept_id: row.dept_id})
SET n.dept_name = row.dept_name, n.building = row.building, n.dept_code = row.dept_code`,
  Faculty: `UNWIND $rows AS row
MERGE (n:Faculty {faculty_id: row.faculty_id})
SET n.name = row.name, n.email = row.email, n.dept_id = row.dept_id`,
  Course: `UNWIND $rows AS row
MERGE (n:Course {course_id: row.course_id})
SET n.course_name = row.course_name, n.credits = row.credits,
    n.weekly_hours = row.weekly_hours, n.course_type = row.course_type, n.dept_id = row.dept_id`,
  Section: `UNWIND $rows AS row
MERGE (n:Section {section_id: row.section_id})
SET n.section_name = row.section_name, n.semester = row.semester,
    n.strength = row.strength, n.dept_id = row.dept_id, n.label = row.label`,
  Student: `UNWIND $rows AS row
MERGE (n:Student {student_id: row.student_id})
SET n.name = row.name, n.email = row.email, n.section_id = row.section_id`,
  Classroom: `UNWIND $rows AS row
MERGE (n:Classroom {room_id: row.room_id})
SET n.room_no = row.room_no, n.building = row.building,
    n.capacity = row.capacity, n.room_type = row.room_type`,
  TimeSlot: `UNWIND $rows AS row
MERGE (n:TimeSlot {slot_id: row.slot_id})
SET n.day_of_week = row.day_of_week, n.day_no = row.day_no, n.period_no = row.period_no,
    n.start_time = row.start_time, n.end_time = row.end_time`,
};

/**
 * Static relationships: the MySQL query (its first two columns are the endpoint keys) and the
 * endpoints (from label, from key, to label, to key), used to PRUNE relationships whose MySQL row
 * was deleted, so MERGE-only loading cannot leave ghosts behind.
 */
const STATIC: Record<string, { sql: string; ends: [string, string, string, string] }> = {
  WORKS_IN: { sql: "SELECT faculty_id, dept_id FROM Faculty", ends: ["Faculty", "faculty_id", "Department", "dept_id"] },
  OFFERED_BY: { sql: "SELECT course_id, dept_id FROM Course", ends: ["Course", "course_id", "Department", "dept_id"] },
  BELONGS_TO: { sql: "SELECT section_id, dept_id FROM Section", ends: ["Section", "section_id", "Department", "dept_id"] },
  STUDIES_IN: { sql: "SELECT student_id, section_id FROM Student", ends: ["Student", "student_id", "Section", "section_id"] },
  TEACHES: { sql: "SELECT faculty_id, course_id FROM Teaches", ends: ["Faculty", "faculty_id", "Course", "course_id"] },
  ENROLLED_IN: { sql: "SELECT student_id, course_id FROM Enrollment", ends: ["Student", "student_id", "Course", "course_id"] },
  TAKES: { sql: "SELECT section_id, course_id, semester FROM Section_Course", ends: ["Section", "section_id", "Course", "course_id"] },
};
export const REL_ENDPOINTS = Object.fromEntries(Object.entries(STATIC).map(([rel, s]) => [rel, s.ends]));

export const Q_RELS: Record<string, string> = {
  WORKS_IN: `UNWIND $rows AS row
MATCH (f:Faculty {faculty_id: row.faculty_id}), (d:Department {dept_id: row.dept_id})
MERGE (f)-[:WORKS_IN]->(d)`,
  OFFERED_BY: `UNWIND $rows AS row
MATCH (c:Course {course_id: row.course_id}), (d:Department {dept_id: row.dept_id})
MERGE (c)-[:OFFERED_BY]->(d)`,
  BELONGS_TO: `UNWIND $rows AS row
MATCH (s:Section {section_id: row.section_id}), (d:Department {dept_id: row.dept_id})
MERGE (s)-[:BELONGS_TO]->(d)`,
  STUDIES_IN: `UNWIND $rows AS row
MATCH (st:Student {student_id: row.student_id}), (s:Section {section_id: row.section_id})
MERGE (st)-[:STUDIES_IN]->(s)`,
  TEACHES: `UNWIND $rows AS row
MATCH (f:Faculty {faculty_id: row.faculty_id}), (c:Course {course_id: row.course_id})
MERGE (f)-[:TEACHES]->(c)`,
  ENROLLED_IN: `UNWIND $rows AS row
MATCH (st:Student {student_id: row.student_id}), (c:Course {course_id: row.course_id})
MERGE (st)-[:ENROLLED_IN]->(c)`,
  TAKES: `UNWIND $rows AS row
MATCH (s:Section {section_id: row.section_id}), (c:Course {course_id: row.course_id})
MERGE (s)-[t:TAKES]->(c)
SET t.semester = row.semester`,
};

export const Q_PRUNE: Record<string, string> = Object.fromEntries(
  Object.entries(STATIC).map(([rel, { ends: [a, ka, b, kb] }]) => [
    rel, `MATCH (a:${a})-[r:${rel}]->(b:${b})\nWHERE NOT [a.${ka}, b.${kb}] IN $keys\nDELETE r`,
  ]),
);

// one SCHEDULED_IN per Timetable row; MERGE key = timetable_id (unique constraint)
export const Q_SCHEDULED = `UNWIND $rows AS row
MATCH (c:Course {course_id: row.course_id}), (sec:Section {section_id: row.section_id})
MERGE (c)-[s:SCHEDULED_IN {timetable_id: row.timetable_id}]->(sec)
SET s.academic_year = row.academic_year, s.course_id = row.course_id,
    s.section_id = row.section_id, s.faculty_id = row.faculty_id,
    s.faculty_name = row.faculty_name, s.room_id = row.room_id,
    s.room_label = row.room_label, s.slot_id = row.slot_id,
    s.day_of_week = row.day_of_week, s.day_no = row.day_no, s.period_no = row.period_no,
    s.start_time = row.start_time, s.end_time = row.end_time`;

// derived: which faculty actually teaches which section (and how many periods)
export const Q_TEACHES_SECTION = `MATCH (c:Course)-[s:SCHEDULED_IN {academic_year: $year}]->(sec:Section)
WITH s.faculty_id AS fid, c, sec, count(s) AS periods
MATCH (f:Faculty {faculty_id: fid})
MERGE (f)-[t:TEACHES_SECTION {academic_year: $year, course_id: c.course_id}]->(sec)
SET t.periods = periods`;

// derived CONFLICTS_WITH: same definition as buildConflictGraph
export const Q_CONFLICTS = [
  "MATCH ()-[r:CONFLICTS_WITH]->() DELETE r",
  `MATCH (a:Course)<-[:TEACHES]-(f:Faculty)-[:TEACHES]->(b:Course)
WHERE a.course_id < b.course_id
WITH a, b, count(DISTINCT f) AS shared_faculty
MERGE (a)-[r:CONFLICTS_WITH]->(b)
SET r.shared_faculty = shared_faculty`,
  `MATCH (a:Course)<-[:ENROLLED_IN]-(st:Student)-[:ENROLLED_IN]->(b:Course)
WHERE a.course_id < b.course_id
WITH a, b, count(DISTINCT st) AS shared_students
MERGE (a)-[r:CONFLICTS_WITH]->(b)
SET r.shared_students = shared_students`,
  `MATCH ()-[r:CONFLICTS_WITH]->()
SET r.shared_faculty = coalesce(r.shared_faculty, 0),
    r.shared_students = coalesce(r.shared_students, 0),
    r.shared_count = coalesce(r.shared_faculty, 0) + coalesce(r.shared_students, 0)`,
];

const Q_TIMETABLE_SQL = `
SELECT t.timetable_id, t.course_id, t.faculty_id, f.name AS faculty_name,
       t.room_id, CONCAT(r.building, '-', r.room_no) AS room_label,
       t.slot_id, ts.day_of_week, ts.period_no, ts.start_time, ts.end_time,
       t.section_id, t.academic_year
FROM Timetable t
JOIN Faculty   f  ON f.faculty_id = t.faculty_id
JOIN Classroom r  ON r.room_id    = t.room_id
JOIN TimeSlot  ts ON ts.slot_id   = t.slot_id
WHERE t.academic_year = ?
ORDER BY t.timetable_id`;

/** day_no and "HH:MM" times, as stored in the graph. */
const slotFields = (r: Row): Row => ({ ...r, day_no: DAY_NO[r.day_of_week], start_time: fmtTime(r.start_time), end_time: fmtTime(r.end_time) });

// ---------------------------------------------------------------- the ETL
/** Step 1: constraints and indexes (all IF NOT EXISTS). */
export async function applySchema(session: EtlSession, log: Log = console.log): Promise<void> {
  const stmts = readStatements(CONSTRAINTS_FILE);
  for (const s of stmts) await write(session, s);
  log(`  constraints/indexes          ${String(stmts.length).padStart(6)} statements`);
}

export async function loadNodes(session: EtlSession, conn: Db, log: Log = console.log): Promise<void> {
  const depts = (await query(conn, "SELECT dept_id, dept_name, building FROM Department")).map((d) => ({ ...d, dept_code: deptCode(d.dept_name) }));
  await batched(session, Q_NODES.Department, depts, "Department", log);
  await batched(session, Q_NODES.Faculty, await query(conn, "SELECT faculty_id, name, email, dept_id FROM Faculty"), "Faculty", log);
  await batched(session, Q_NODES.Course,
    await query(conn, "SELECT course_id, course_name, credits, weekly_hours, course_type, dept_id FROM Course"), "Course", log);

  const sections = await query(conn,
    "SELECT s.section_id, s.section_name, s.semester, s.strength, s.dept_id, d.dept_name " +
    "FROM Section s JOIN Department d ON d.dept_id = s.dept_id");
  const labelled = sections.map(({ dept_name, ...s }) => ({ ...s, label: `${deptCode(dept_name)} Sem ${s.semester} ${s.section_name}` }));
  await batched(session, Q_NODES.Section, labelled, "Section", log);

  await batched(session, Q_NODES.Student, await query(conn, "SELECT student_id, name, email, section_id FROM Student"), "Student", log);
  await batched(session, Q_NODES.Classroom,
    await query(conn, "SELECT room_id, room_no, building, capacity, room_type FROM Classroom"), "Classroom", log);
  const slots = await query(conn, "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot");
  await batched(session, Q_NODES.TimeSlot, slots.map(slotFields), "TimeSlot", log);
}

export async function loadStaticRelationships(session: EtlSession, conn: Db, log: Log = console.log): Promise<void> {
  for (const [rel, { sql, ends }] of Object.entries(STATIC)) {
    const rows = await query(conn, sql);
    await batched(session, Q_RELS[rel], rows, rel, log);
    await write(session, Q_PRUNE[rel], { keys: rows.map((r) => [r[ends[1]], r[ends[3]]]) });
  }
}

/** Rebuild SCHEDULED_IN and TEACHES_SECTION for the given year(s). */
export async function loadTimetable(session: EtlSession, conn: Db, years: string[], allYears: boolean, log: Log = console.log): Promise<void> {
  if (allYears) { // full sync: drop every year, then reload all
    await write(session, "MATCH ()-[s:SCHEDULED_IN]->() DELETE s");
    await write(session, "MATCH ()-[t:TEACHES_SECTION]->() DELETE t");
  }
  for (const year of years) {
    if (!allYears) {
      await write(session, "MATCH ()-[s:SCHEDULED_IN {academic_year: $year}]->() DELETE s", { year });
      await write(session, "MATCH ()-[t:TEACHES_SECTION {academic_year: $year}]->() DELETE t", { year });
    }
    const rows = (await query(conn, Q_TIMETABLE_SQL, [year])).map(slotFields);
    await batched(session, Q_SCHEDULED, rows, `SCHEDULED_IN [${year}]`, log);
    await write(session, Q_TEACHES_SECTION, { year });
    log(`  TEACHES_SECTION [${year}]      derived`);
  }
}

export async function deriveConflicts(session: EtlSession, log: Log = console.log): Promise<void> {
  for (const stmt of Q_CONFLICTS) await write(session, stmt);
  log("  CONFLICTS_WITH               derived");
}

// -------------------------------------------------------------- verification
/** What the graph should contain, computed from MySQL. */
export async function expectedCounts(conn: Db, years: string[]): Promise<Counts> {
  const one = async (sql: string, params: unknown[] = []) => Number((await query(conn, sql, params))[0].n);
  const nodes: Record<string, number> = {};
  for (const label of ["Department", "Faculty", "Course", "Section", "Student", "Classroom", "TimeSlot"])
    nodes[label] = await one(`SELECT COUNT(*) AS n FROM ${label}`);
  const relationships: Record<string, number> = {
    WORKS_IN: nodes.Faculty, OFFERED_BY: nodes.Course, BELONGS_TO: nodes.Section, STUDIES_IN: nodes.Student,
    TEACHES: await one("SELECT COUNT(*) AS n FROM Teaches"),
    ENROLLED_IN: await one("SELECT COUNT(*) AS n FROM Enrollment"),
    TAKES: await one("SELECT COUNT(*) AS n FROM Section_Course"),
  };
  let sched = 0, teachesSection = 0;
  for (const y of years) {
    sched += await one("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [y]);
    teachesSection += await one("SELECT COUNT(*) AS n FROM (SELECT DISTINCT faculty_id, section_id, course_id " +
      "FROM Timetable WHERE academic_year = ?) x", [y]);
  }
  const graph = await buildConflictGraph(conn);
  relationships.SCHEDULED_IN = sched;
  relationships.TEACHES_SECTION = teachesSection;
  relationships.CONFLICTS_WITH = [...graph.values()].reduce((a, nb) => a + nb.size, 0) / 2; // each pair counted twice
  return { nodes, relationships };
}

/** Academic years that currently have SCHEDULED_IN relationships in the graph. */
export async function graphYears(session: EtlSession): Promise<string[]> {
  return session.executeRead(async (tx) => {
    const res = await tx.run("MATCH ()-[s:SCHEDULED_IN]->() RETURN DISTINCT s.academic_year AS y ORDER BY y");
    return res.records.map((r) => r.get("y") as string);
  });
}

export async function actualCounts(session: EtlSession): Promise<Counts> {
  return { nodes: await nodeCounts(session), relationships: await relationshipCounts(session) };
}

/** Mismatch descriptions (empty = graph matches MySQL). */
export function compareCounts(expected: Counts, actual: Counts): string[] {
  const problems: string[] = [];
  for (const kind of ["nodes", "relationships"] as const) {
    for (const [name, want] of Object.entries(expected[kind])) {
      const got = actual[kind][name] ?? 0;
      if (got !== want) problems.push(`${kind.slice(0, -1)} ${name}: MySQL expects ${want}, Neo4j has ${got}`);
    }
  }
  return problems;
}

export interface EtlOptions {
  reset?: boolean;
  log?: Log;
  role?: Role; // MySQL account (db.ts); the web API passes the user's role
  session?: EtlSession; // instead of a session on the shared driver (tests)
}

/** Full ETL. `academicYear` null syncs every year present in Timetable. */
export async function runEtl(academicYear: string | null = null, opts: EtlOptions = {}): Promise<EtlResult> {
  const log = opts.log ?? console.log;
  const t0 = performance.now();
  const { expected, actual } = await withConnection(async (conn) => {
    const years = academicYear ? [academicYear]
      : (await query(conn, "SELECT DISTINCT academic_year FROM Timetable ORDER BY academic_year")).map((r) => r.academic_year as string);
    log(`MySQL -> Neo4j ETL (years: ${years.join(", ") || "none; no timetable yet"})`);
    const own = opts.session ? null : (await getDriver()).session({ database: neo4jSettings().database });
    const session = (opts.session ?? own)!;
    try {
      if (opts.reset) {
        await write(session, "MATCH (n) DETACH DELETE n");
        log("  graph wiped (--reset)");
      }
      await applySchema(session, log);
      await loadNodes(session, conn, log);
      await loadStaticRelationships(session, conn, log);
      await loadTimetable(session, conn, years, academicYear === null, log);
      await deriveConflicts(session, log);
      // verify every year the graph holds, not only the one just reloaded: with a single
      // year, other years' classes stay in the graph and must still match MySQL
      const all = [...new Set([...years, ...(await graphYears(session))])].sort();
      return { expected: await expectedCounts(conn, all), actual: await actualCounts(session) };
    } finally {
      await own?.close();
    }
  }, opts.role);
  const problems = compareCounts(expected, actual);
  log(`\nVerification: ${problems.length ? "MISMATCH" : "OK, graph matches MySQL"} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  for (const p of problems) log(`  ! ${p}`);
  return { expected, actual, problems, ok: problems.length === 0 };
}

// --------------------------------------------------------------------- CLI
const USAGE = "usage: npm run etl -- [-h] [--year YEAR] [--reset]";

/** CLI entry (scripts/etl.ts): exit code 0 = graph matches MySQL, 1 = mismatch, 2 = cannot connect / bad usage. */
export async function etlMain(argv: string[]): Promise<number> {
  let values: { year?: string; reset?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args: argv, options: { year: { type: "string" }, reset: { type: "boolean" }, help: { type: "boolean", short: "h" } } }));
  } catch (e) {
    console.error(`${USAGE}\netl: error: ${(e as Error).message}`);
    return 2;
  }
  if (values.help) {
    console.log(`${USAGE}\n\nExport MySQL timetable data into Neo4j.\n\n` +
      "options:\n  -h, --help   show this help message and exit\n" +
      "  --year YEAR  only (re)load this academic year's timetable\n  --reset      delete everything in the graph first");
    return 0;
  }
  try {
    return (await runEtl(values.year ?? null, { reset: values.reset })).ok ? 0 : 1;
  } catch (e) {
    const err = e as Error & { sqlMessage?: string; code?: string };
    const down = neo4jDownReason(e);
    if (down) {
      console.error(`\nCould not use Neo4j (${down}): ${err.message}\n` +
        "Check that Neo4j is running (bin/neo4j console), and that NEO4J_URI / " +
        "NEO4J_USER / NEO4J_PASSWORD are set correctly.\nDiagnose with: npm run queries -- check");
      return 2;
    }
    if (err.sqlMessage !== undefined || /MYSQL|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(`${err.message} ${err.code}`)) {
      console.error(`\nCould not use MySQL: ${err.message}\nCheck that the database server is running and MYSQL_* in .env are correct.`);
      return 2;
    }
    throw e;
  } finally {
    await closeDriver();
  }
}
