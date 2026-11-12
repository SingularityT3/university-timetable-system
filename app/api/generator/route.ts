import { withConnection } from "@/lib/server/db";
import { yearOrDefault } from "@/lib/server/api";
import { Fields, route, yearField } from "@/lib/server/http";
import { generateTimetable, MAX_FAC_CONSEC, report, resultStatus } from "@/lib/server/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only. Build (and unless dry_run, save) a timetable. */
export const POST = route(async ({ req }) => {
  const b = await Fields.body(req);
  const year = yearField(b);
  const opts = {
    replace: b.bool("replace", false),
    allowPartial: b.bool("allow_partial", false),
    dryRun: b.bool("dry_run", false),
    timeLimit: b.float("time_limit", { default: 30, ge: 5, le: 120 }),
    seed: b.int("seed", { default: 42 }),
  };
  b.check();
  const res = await withConnection((conn) => generateTimetable({ academicYear: yearOrDefault(year), ...opts, conn }), "admin");
  return {
    status: resultStatus(res), academic_year: res.academic_year, placed: res.placed, required: res.required,
    complete: res.complete, committed: res.committed, nodes: res.nodes, attempts: res.attempts,
    elapsed: Math.round(res.elapsed * 1000) / 1000, soft: res.soft, preflight: res.preflight, unplaced: res.unplaced,
    error: res.error, note: res.note, report: report(res), max_fac_consec: MAX_FAC_CONSEC,
  };
}, { admin: true });
