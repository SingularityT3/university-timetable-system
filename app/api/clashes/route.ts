import { callProcedure, pool } from "@/lib/server/db";
import { clean, countClasses, yearOrDefault } from "@/lib/server/api";
import { route, yearField } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clashes (sp_list_clashes) and hour gaps (sp_hours_coverage) of the saved timetable. */
export const GET = route(async ({ user, query: q }) => {
  const year = yearOrDefault(yearField(q));
  q.check();
  const db = pool(user.role);
  const n = await countClasses(db, year);
  if (n === 0) return { classes: 0, clashes: [], gaps: [] };
  return {
    classes: n,
    clashes: clean(await callProcedure(db, "sp_list_clashes", [year])),
    gaps: clean(await callProcedure(db, "sp_hours_coverage", [year])),
  };
});
