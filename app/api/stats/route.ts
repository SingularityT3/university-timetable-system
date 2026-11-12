import { callProcedure, pool, query } from "@/lib/server/db";
import { clean, countClasses, orGraphError, yearOrDefault } from "@/lib/server/api";
import { route, yearField } from "@/lib/server/http";
import { crossDepartmentTeaching, mostConflictedCourses } from "@/lib/server/neo4j";
import { DAY_NO } from "@/lib/server/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the statistics page shows (MySQL procedures and queries, plus Neo4j insights). */
export const GET = route(async ({ user, query: q }) => {
  const year = yearOrDefault(yearField(q));
  q.check();
  const db = pool(user.role);
  const rows = async (sql: string) => clean(await query(db, sql, [year]));
  const byDay = await rows("SELECT ts.day_of_week AS day, COUNT(*) AS classes FROM Timetable t " +
    "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = ? GROUP BY ts.day_of_week");
  byDay.sort((a, b) => DAY_NO[a.day] - DAY_NO[b.day]);
  const graph = await orGraphError(async () => ({
    conflicted: await mostConflictedCourses(10),
    bridges: await crossDepartmentTeaching(),
  }));
  return {
    classes: await countClasses(db, year),
    workload: clean(await callProcedure(db, "sp_faculty_workload", [year])),
    rooms: clean(await callProcedure(db, "sp_room_utilization", [year])),
    by_day: byDay,
    by_period: await rows("SELECT ts.period_no AS period, COUNT(*) AS classes FROM Timetable t " +
      "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = ? GROUP BY ts.period_no ORDER BY ts.period_no"),
    kinds: await rows("SELECT c.course_type AS type, COUNT(*) AS classes FROM Timetable t " +
      "JOIN Course c ON c.course_id = t.course_id WHERE t.academic_year = ? GROUP BY c.course_type ORDER BY c.course_type"),
    section_load: await rows("SELECT CONCAT(dept_name, ' S', semester, section_name) AS section, day_of_week AS day, " +
      "COUNT(*) AS n FROM v_section_timetable WHERE academic_year = ? " +
      "GROUP BY dept_name, semester, section_name, day_of_week ORDER BY dept_name, semester, section_name"),
    departments: clean(await callProcedure(db, "sp_department_summary", [year])),
    graph,
  };
});
