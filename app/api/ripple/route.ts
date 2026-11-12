import { route } from "@/lib/server/http";
import { moveClassRipple } from "@/lib/server/neo4j";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What collides if this class moves to (day, period)? (Neo4j) */
export const GET = route(async ({ query: q }) => {
  const timetableId = q.int("timetable_id");
  const day = q.str("day");
  const period = q.int("period", { ge: 1, le: 8 });
  q.check();
  return moveClassRipple(timetableId, day, period);
});
