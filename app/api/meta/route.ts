import { pool, query } from "@/lib/server/db";
import { academicYear } from "@/lib/server/env";
import { clean, neo4jStatus } from "@/lib/server/api";
import { route } from "@/lib/server/http";
import { DAY_ORDER } from "@/lib/server/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECTIONS =
  "SELECT s.section_id AS id, CONCAT(d.dept_name, ' / Sem ', s.semester, ' / ', s.section_name) AS label " +
  "FROM Section s JOIN Department d ON d.dept_id = s.dept_id ORDER BY d.dept_name, s.semester, s.section_name";
const FACULTY =
  "SELECT f.faculty_id AS id, CONCAT(f.name, ' (', d.dept_name, ')') AS label, f.name " +
  "FROM Faculty f JOIN Department d ON d.dept_id = f.dept_id ORDER BY d.dept_name, f.name";
const ROOMS =
  "SELECT room_id AS id, CONCAT(building, ' ', room_no, ' (', room_type, ', ', capacity, ' seats)') AS label " +
  "FROM Classroom ORDER BY building, room_no";
const COURSES = "SELECT course_id AS id, CONCAT(course_id, ' ', course_name, ' (', course_type, ')') AS label FROM Course ORDER BY course_id";
const SLOTS =
  "SELECT slot_id AS id, CONCAT(day_of_week, ' P', period_no, ' ', TIME_FORMAT(start_time, '%H:%i')) AS label, " +
  "day_of_week, period_no, start_time, end_time FROM TimeSlot ORDER BY slot_id";

/** Everything the select boxes need, the years with saved classes and the Neo4j status. */
export const GET = route(async ({ user }) => {
  const db = pool(user.role);
  const q = async (sql: string) => clean(await query(db, sql));
  const counts = new Map((await q("SELECT academic_year AS y, COUNT(*) AS n FROM Timetable GROUP BY academic_year"))
    .map((r) => [r.y as string, Number(r.n)]));
  const dflt = academicYear();
  const years = [...new Set([...counts.keys(), dflt])].sort().reverse();
  const [ok, detail] = await neo4jStatus();
  return {
    default_year: dflt,
    years,
    days: DAY_ORDER,
    sections: await q(SECTIONS),
    faculty: await q(FACULTY),
    rooms: await q(ROOMS),
    courses: await q(COURSES),
    slots: await q(SLOTS),
    neo4j: { ok, detail },
    counts: Object.fromEntries(years.map((y) => [y, counts.get(y) ?? 0])),
  };
});
