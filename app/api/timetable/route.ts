import { pool, query, type Row } from "@/lib/server/db";
import { clean, yearOrDefault } from "@/lib/server/api";
import { HttpError, route, yearField } from "@/lib/server/http";
import { pyList } from "@/lib/server/neo4j";
import { buildWeekGrid, DAY_NO, deptCode } from "@/lib/server/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sec = (r: Row) => `${deptCode(r.dept_name)} Sem ${r.semester} ${r.section_name}`;

/** view -> [column, lines shown in each grid block] */
const VIEWS: Record<string, [string, (r: Row) => string[]]> = {
  section: ["section_id", (r) => [r.course_id, r.faculty_name, `${r.building} ${r.room_no}`]],
  faculty: ["faculty_id", (r) => [r.course_id, sec(r), `${r.building} ${r.room_no}`]],
  room: ["room_id", (r) => [r.course_id, sec(r), r.faculty_name]],
};

/** One section's, faculty member's or room's week: grid, rows and metrics. */
export const GET = route(async ({ user, query: q }) => {
  const id = q.int("id");
  const view = q.str("view", { default: "section" });
  const year = yearField(q);
  q.check();
  if (!Object.hasOwn(VIEWS, view)) throw new HttpError(400, `view must be one of ${pyList(Object.keys(VIEWS).sort())}`);
  const [col, lines] = VIEWS[view];
  const db = pool(user.role);
  const slots = await query(db, "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot ORDER BY slot_id");
  const rows = clean(await query(db, `SELECT * FROM v_section_timetable WHERE academic_year = ? AND ${col} = ?`, [yearOrDefault(year), id]));
  rows.sort((a, b) => DAY_NO[a.day_of_week] - DAY_NO[b.day_of_week] || a.period_no - b.period_no);
  const grid = buildWeekGrid(slots, rows.map((r) => ({ ...r, lines: lines(r) })));
  return {
    grid,
    rows,
    metrics: {
      periods: rows.length,
      courses: new Set(rows.map((r) => r.course_id)).size,
      days: new Set(rows.map((r) => r.day_of_week)).size,
    },
  };
});
