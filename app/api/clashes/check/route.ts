import { withConnection } from "@/lib/server/db";
import { yearOrDefault } from "@/lib/server/api";
import { Fields, route, yearField } from "@/lib/server/http";
import { checkProposedClass } from "@/lib/server/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Would MySQL accept this class? Read-only, so faculty may use it too. */
export const POST = route(async ({ req, user }) => {
  const b = await Fields.body(req);
  const year = yearOrDefault(yearField(b));
  const args = [b.int("section_id"), b.str("course_id", { maxLength: 10 }), b.int("faculty_id"), b.int("room_id"), b.int("slot_id")] as const;
  b.check();
  const results = await withConnection((c) => checkProposedClass(c, year, ...args), user.role);
  const hard = results.filter((r) => !r.ok && r.hard).length;
  return { accepted: hard === 0, hard_broken: hard, results };
});
