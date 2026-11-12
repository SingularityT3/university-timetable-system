import { callProcedure, pool } from "@/lib/server/db";
import { clean, yearOrDefault } from "@/lib/server/api";
import { HttpError, route, yearField } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Maximal runs of free periods of a faculty member or room (sp_free_blocks, a recursive CTE). */
export const GET = route(async ({ user, query: q }) => {
  const kind = q.str("kind").toUpperCase();
  const id = q.int("id");
  const year = yearField(q);
  q.check();
  if (kind !== "FACULTY" && kind !== "ROOM") throw new HttpError(400, "kind must be FACULTY or ROOM");
  return clean(await callProcedure(pool(user.role), "sp_free_blocks", [yearOrDefault(year), kind, id]));
});
