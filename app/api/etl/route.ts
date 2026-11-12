import { runEtl } from "@/lib/server/etl";
import { Fields, route, yearField } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only. Refresh the Neo4j graph from MySQL (one year; every year when year is null). */
export const POST = route(async ({ req }) => {
  const b = await Fields.body(req);
  const year = yearField(b);
  b.check();
  const log: string[] = [];
  const result = await runEtl(year || null, { log: (line) => log.push(line), role: "admin" });
  return { ok: result.ok, problems: result.problems, log };
}, { admin: true });
