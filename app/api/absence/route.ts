import { pool } from "@/lib/server/db";
import { graphStaleMessage, yearOrDefault } from "@/lib/server/api";
import { route, yearField } from "@/lib/server/http";
import { facultyAbsencePlan } from "@/lib/server/neo4j";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Affected classes + substitute candidates (Neo4j), plus a note when the graph is out of date. */
export const GET = route(async ({ user, query: q }) => {
  const facultyId = q.int("faculty_id");
  const year = yearOrDefault(yearField(q));
  const day = q.optStr("day");
  q.check();
  const plan = await facultyAbsencePlan(facultyId, year, day || null);
  return { ...plan, stale: await graphStaleMessage(pool(user.role), year) };
});
