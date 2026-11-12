import { Fields, route } from "@/lib/server/http";
import { deleteUnavailability, listUnavailability, MAX_REASON, setUnavailability } from "@/lib/server/neo4j";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** UNAVAILABLE_AT marks of one faculty member (or of everyone). */
export const GET = route(async ({ query: q }) => {
  const facultyId = q.optInt("faculty_id");
  q.check();
  return listUnavailability(facultyId);
});

/** Admin only. Create or update a mark. */
export const PUT = route(async ({ req }) => {
  const b = await Fields.body(req);
  const facultyId = b.int("faculty_id");
  const slotId = b.int("slot_id");
  const reason = b.str("reason", { default: "", maxLength: MAX_REASON });
  b.check();
  return setUnavailability(facultyId, slotId, reason);
}, { admin: true });

/** Admin only. Remove a mark. */
export const DELETE = route(async ({ query: q }) => {
  const facultyId = q.int("faculty_id");
  const slotId = q.int("slot_id");
  q.check();
  return { deleted: await deleteUnavailability(facultyId, slotId) };
}, { admin: true });
