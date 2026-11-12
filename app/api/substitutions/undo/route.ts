import { withConnection } from "@/lib/server/db";
import { refreshGraph } from "@/lib/server/api";
import { Fields, route } from "@/lib/server/http";
import { revertSubstitution, type SubstitutionChange } from "@/lib/server/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only. Revert a substitution (and the Teaches row it added); send back the change unchanged. */
export const POST = route(async ({ req }) => {
  const b = await Fields.body(req);
  const c = b.object("change");
  const sent: SubstitutionChange = {
    timetable_id: c.int("timetable_id"), academic_year: c.str("academic_year"), course_id: c.str("course_id"),
    section_id: c.int("section_id"), slot_id: c.int("slot_id"),
    old_faculty_id: c.int("old_faculty_id"), old_faculty: c.str("old_faculty"),
    new_faculty_id: c.int("new_faculty_id"), new_faculty: c.str("new_faculty"), teaches_added: c.bool("teaches_added"),
  };
  b.check();
  const change = await withConnection((conn) => revertSubstitution(conn, sent), "admin");
  return { change, graph_problem: await refreshGraph(change.academic_year) };
}, { admin: true });
