/**
 * The documented Cypher queries from the command line (lib/server/neo4j.ts).
 *   npm run queries -- check    test the Neo4j connection and show which settings are used
 *   npm run queries -- list     query names
 *   npm run queries -- demo     run every query with sample inputs
 */
import { academicYear } from "@/lib/server/env";
import * as NQ from "@/lib/server/neo4j";
import type { Row } from "@/lib/server/db";
import { formatTable } from "@/lib/server/utils";

async function demo(): Promise<void> {
  const year = academicYear();
  const show = (title: string, rows: Row[], n = 8) => console.log(`\n=== ${title}\n${formatTable(rows, undefined, n)}`);

  console.log(`Academic year: ${year}`);
  show("Graph size: nodes", Object.entries(await NQ.nodeCounts()).map(([label, count]) => ({ label, count })), 20);
  show("Graph size: relationships", Object.entries(await NQ.relationshipCounts()).map(([type, count]) => ({ type, count })), 20);

  const plan = await NQ.facultyAbsencePlan(1, year, "MON");
  const s = plan.summary;
  console.log(`\n=== Q1/Q2 Faculty 1 absent on MON: {'classes_affected': ${s.classes_affected}, ` +
    `'sections_affected': ${s.sections_affected}, 'students_affected': ${s.students_affected}, ` +
    `'coverable': ${s.coverable}, 'needs_teaches_row': ${s.needs_teaches_row}, 'uncovered': ${s.uncovered}}`);
  for (const c of plan.classes.slice(0, 4)) {
    const best = (c.substitutes as Row[]).slice(0, 3).map((x) => `${x.candidate} (${x.fit})`).join(", ") || "none";
    console.log(`  ${c.day} P${c.period} ${c.course_id} ${c.section}: ${c.status} -> ${best}`);
  }

  show("Q3 Most conflicted courses", await NQ.mostConflictedCourses(5));
  show("Q4 Free LECTURE rooms (>=60 seats) MON period 1", await NQ.freeRooms("MON", 1, 60, "LECTURE", year), 6);
  show("Q5 Students with the heaviest day", await NQ.heaviestDayStudents(5, year));
  const sp = await NQ.facultyShortestPath(1, 11);
  console.log("\n=== Q6 Shortest path faculty 1 -> 11:", sp.connected ? `${sp.hops} hops` : "not connected");
  if (sp.connected) console.log("   " + sp.path.map((n) => `${n.kind}:${n.name}`).join("  ->  "));
  show("Q7 Faculty workload ranking", await NQ.facultyWorkloadRanking(year), 6);
  const mine = await NQ.impactAnalysis(1, year);
  if (mine.length) {
    const r = await NQ.moveClassRipple(mine[0].timetable_id, "FRI", 8);
    console.log(`\n=== Q8 Move class ${r.moved.moved_timetable_id} (${r.moved.moved_course}) to FRI P8: ` +
      (r.free_move ? "free move" : `${r.clashes.length} clash(es)`));
    console.log(formatTable(r.clashes, ["clash_course", "clash_section", "clash_faculty", "clash_types"]));
  }
  show("Q9 Cross-department teaching", await NQ.crossDepartmentTeaching());
  show("Q10 Conflict neighbours of CS301", await NQ.courseConflictNeighbours("CS301"), 6);
}

async function main(args: string[]): Promise<number> {
  const cmd = args[0] ?? "list";
  if (cmd === "list") {
    for (const [name, text] of Object.entries(NQ.queries())) {
      const first = text.split("\n").find((l) => l.trim().startsWith("//"))?.replace(/^[/ ]+/, "").trim() ?? "";
      console.log(`${name.padEnd(28)} ${first}`);
    }
    return 0;
  }
  if (cmd === "check") { // diagnose connection / password problems
    console.log(NQ.describeNeo4jSettings().join("\n"));
    try {
      await NQ.getDriver();
      console.log("Connection: OK (Neo4j reachable and login accepted)");
      return 0;
    } catch (e) {
      const err = e as Error;
      console.log(`Connection: FAILED (${NQ.neo4jDownReason(e) ?? err.name}): ${err.message.slice(0, 160)}`);
      return 2;
    }
  }
  if (cmd === "demo") {
    try {
      await demo();
      return 0;
    } catch (e) {
      const down = NQ.neo4jDownReason(e);
      if (!down) throw e;
      console.error(`\nCould not use Neo4j (${down}): ${(e as Error).message}\n` +
        "Check that Neo4j is running (bin/neo4j console) and that NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in .env are correct.\n" +
        "Diagnose with: npm run queries -- check");
      return 2;
    }
  }
  console.log("usage: npm run queries -- [list|demo|check]");
  return 2;
}

main(process.argv.slice(2))
  .then((code) => (process.exitCode = code))
  .finally(NQ.closeDriver);
