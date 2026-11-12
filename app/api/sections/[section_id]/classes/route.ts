import { pool, query } from "@/lib/server/db";
import { clean, yearOrDefault } from "@/lib/server/api";
import { Fields, route, yearField } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The saved classes of one section (for the "move a class" picker). */
export const GET = route<{ section_id: string }>(async ({ user, params, query: q }) => {
  const path = new Fields(params, ["path"]);
  const sectionId = path.int("section_id");
  const year = yearOrDefault(yearField(q));
  path.check(q);
  return clean(await query(pool(user.role),
    "SELECT t.timetable_id, ts.day_of_week, ts.period_no, t.course_id, f.name AS faculty " +
    "FROM Timetable t JOIN TimeSlot ts ON ts.slot_id = t.slot_id JOIN Faculty f ON f.faculty_id = t.faculty_id " +
    "WHERE t.academic_year = ? AND t.section_id = ? ORDER BY ts.slot_id", [year, sectionId]));
});
