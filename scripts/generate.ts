/**
 * Generate a clash-free university timetable (CLI of lib/server/generator.ts).
 *
 *   npm run generate -- [--year Y] [--replace] [--allow-partial] [--dry-run]
 *                       [--time-limit S] [--max-nodes N] [--restarts N] [--seed N]
 *
 * Exit codes: 0 complete (and saved unless --dry-run), 1 not complete / not saved because of an
 * error, 2 MySQL unreachable or misconfigured (or bad arguments).
 */
import { parseArgs } from "node:util";
import { closePools } from "../lib/server/db";
import { generateTimetable, isSuccess, report } from "../lib/server/generator";

const USAGE = "usage: generate [--year YEAR] [--replace] [--allow-partial] [--dry-run] [--time-limit S] " +
  "[--max-nodes N] [--restarts N] [--seed N]";

function number(name: string, value: string | undefined, fallback: number, integer: boolean): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    throw new Error(`argument --${name}: invalid ${integer ? "int" : "float"} value: '${value}'`);
  }
  return n;
}

async function main(argv: string[]): Promise<number> {
  let opts;
  try {
    const { values: a } = parseArgs({
      args: argv,
      options: {
        year: { type: "string" },
        replace: { type: "boolean" },
        "allow-partial": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "time-limit": { type: "string" },
        "max-nodes": { type: "string" },
        restarts: { type: "string" },
        seed: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (a.help) {
      console.log(`${USAGE}\n\nGenerate a clash-free university timetable.`);
      return 0;
    }
    opts = {
      academicYear: a.year,
      replace: !!a.replace,
      allowPartial: !!a["allow-partial"],
      dryRun: !!a["dry-run"],
      timeLimit: number("time-limit", a["time-limit"], 30, false),
      maxNodes: number("max-nodes", a["max-nodes"], 300_000, true),
      restarts: number("restarts", a.restarts, 4, true),
      seed: number("seed", a.seed, 42, true),
    };
  } catch (e) {
    console.error(`${USAGE}\ngenerate: error: ${(e as Error).message}`);
    return 2;
  }

  try {
    const res = await generateTimetable(opts);
    console.log(report(res));
    return isSuccess(res) ? 0 : 1;
  } catch (e) {
    // connection / configuration problems only (mysql2 and socket errors carry a code)
    const err = e as Error & { code?: unknown };
    if (typeof err.code !== "string" && !/MYSQL_/.test(err.message)) throw e;
    console.error(`Could not use MySQL: ${(e as Error).message}\n` +
      "Check that the database server is running and that MYSQL_HOST / MYSQL_PORT / " +
      "MYSQL_USER / MYSQL_PASSWORD in .env are correct (see README, Troubleshooting).");
    return 2;
  } finally {
    await closePools();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
