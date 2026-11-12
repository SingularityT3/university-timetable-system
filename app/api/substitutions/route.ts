import { withConnection } from "@/lib/server/db";
import { refreshGraph } from "@/lib/server/api";
import { Fields, route } from "@/lib/server/http";
import { assignSubstitute } from "@/lib/server/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only. Hand a class to a substitute in MySQL, then refresh the graph for that year. */
export const POST = route(async ({ req }) => {
  const b = await Fields.body(req);
  const timetableId = b.int("timetable_id");
  const facultyId = b.int("faculty_id");
  const addTeaches = b.bool("add_teaches", false);
  b.check();
  const change = await withConnection((c) => assignSubstitute(c, timetableId, facultyId, { addTeaches }), "admin");
  return { change, graph_problem: await refreshGraph(change.academic_year) };
}, { admin: true });
