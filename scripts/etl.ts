/**
 * MySQL -> Neo4j export (lib/server/etl.ts).
 *   npm run etl                       all academic years in Timetable
 *   npm run etl -- --year 2026-2027   only (re)load this year's timetable
 *   npm run etl -- --reset            wipe the graph first (also deletes the unavailability marks)
 * Exit code: 0 graph matches MySQL, 1 mismatch, 2 MySQL/Neo4j unreachable or bad usage.
 */
import { closePools } from "@/lib/server/db";
import { etlMain } from "@/lib/server/etl";

etlMain(process.argv.slice(2))
  .then((code) => (process.exitCode = code))
  .finally(closePools);
