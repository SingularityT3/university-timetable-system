/**
 * The MySQL -> Neo4j export, tested WITHOUT a Neo4j server: a recording stand-in for the
 * Neo4j session captures every statement the ETL would send. MySQL is only read.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, type Row } from "@/lib/server/db";
import * as E from "@/lib/server/etl";
import { buildConflictGraph } from "@/lib/server/utils";
import { realYear, TEST_YEAR } from "./helpers";

type Sent = [string, Row];

/** A session that records writes and answers reads from `reads(cypher)`. */
function recordingSession(reads: (cypher: string) => Row[] = () => []): E.EtlSession & { log: Sent[] } {
  const log: Sent[] = [];
  const tx = {
    run: async (cypher: string, params: Row = {}) => {
      log.push([cypher.trim(), params]);
      return { records: reads(cypher).map((r) => ({ get: (k: string) => r[k], toObject: () => r })) };
    },
  };
  // the stand-in transaction only needs run(); cast for the driver's ManagedTransaction type
  const work = <T>(fn: (t: never) => Promise<T>) => fn(tx as never);
  return { log, executeWrite: work, executeRead: work };
}

const quiet = () => {};
let year: string;
let sent: Sent[];

async function runAll(y: string): Promise<Sent[]> {
  const s = recordingSession();
  const conn = pool();
  await E.applySchema(s, quiet);
  await E.loadNodes(s, conn, quiet);
  await E.loadStaticRelationships(s, conn, quiet);
  await E.loadTimetable(s, conn, [y], false, quiet);
  await E.deriveConflicts(s, quiet);
  return s.log;
}

const rowsSent = (log: Sent[], q: string) =>
  log.filter(([c, p]) => c === q.trim() && p.rows).reduce((n, [, p]) => n + p.rows.length, 0);

beforeAll(async () => {
  year = realYear();
  sent = await runAll(year);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ETL statements", () => {
  it("creates constraints first and conflicts last", () => {
    const kinds = sent.map(([q]) => (q.startsWith("CREATE") ? "schema" : "data"));
    const firstData = kinds.indexOf("data");
    expect(firstData).toBeGreaterThanOrEqual(15);
    expect(kinds.slice(0, firstData).every((k) => k === "schema")).toBe(true);
    expect(kinds.slice(firstData)).not.toContain("schema"); // nothing schema-related after data starts
    expect(sent.at(-1)![0]).toContain("CONFLICTS_WITH"); // derived relationship is built last

    const texts = sent.map(([q]) => q);
    const lastNode = Math.max(...texts.flatMap((q, i) => (/^UNWIND \$rows AS row\s+MERGE \(n:/.test(q) ? [i] : [])));
    const firstRel = Math.min(...texts.flatMap((q, i) => (/^UNWIND \$rows AS row\s+MATCH/.test(q) ? [i] : [])));
    expect(lastNode).toBeLessThan(firstRel); // nodes exist before relationships reference them
  });

  it("sends as many rows as MySQL has", async () => {
    const exp = await E.expectedCounts(pool(), [year]);
    for (const [label, q] of Object.entries(E.Q_NODES)) expect(rowsSent(sent, q), label).toBe(exp.nodes[label]);
    for (const [rel, q] of Object.entries(E.Q_RELS)) expect(rowsSent(sent, q), rel).toBe(exp.relationships[rel]);
    expect(rowsSent(sent, E.Q_SCHEDULED)).toBe(exp.relationships.SCHEDULED_IN);
  });

  it("prunes deleted MySQL rows from every static relationship", async () => {
    // MERGE alone never deletes: each static type is followed by a prune keyed on MySQL's current rows
    const texts = sent.map(([q]) => q);
    const exp = (await E.expectedCounts(pool(), [year])).relationships;
    for (const [rel, q] of Object.entries(E.Q_RELS)) {
      const lastBatch = texts.lastIndexOf(q.trim());
      const prune = texts.indexOf(E.Q_PRUNE[rel].trim());
      expect(prune, rel).toBe(lastBatch + 1); // right after its own (batched) load
      const keys = sent[prune][1].keys as unknown[][];
      expect(keys.length, rel).toBe(exp[rel]);
      expect(keys.every((k) => k.length === 2)).toBe(true);
    }
  });

  it("never sends a batch larger than BATCH_SIZE", async () => {
    expect(Math.max(...sent.filter(([, p]) => p.rows).map(([, p]) => p.rows.length))).toBeLessThanOrEqual(E.BATCH_SIZE);
    const s = recordingSession();
    await E.batched(s, "UNWIND $rows AS row RETURN row", Array.from({ length: 1200 }, (_, i) => ({ i })), "x", quiet);
    expect(s.log.map(([, p]) => p.rows.length)).toEqual([500, 500, 200]);
  });

  it("deletes the old timetable before reloading it", () => {
    const texts = sent.map(([q]) => q);
    const del = texts.findIndex((q) => q.includes("DELETE s"));
    const load = texts.findIndex((q) => q.includes("SCHEDULED_IN {timetable_id"));
    expect(del).toBeGreaterThanOrEqual(0);
    expect(del).toBeLessThan(load); // no ghost classes after a regeneration
  });

  it("never deletes unavailability marks", () => {
    // UNAVAILABLE_AT marks live only in Neo4j: every delete the ETL sends names another relationship type
    const deletes = sent.map(([q]) => q).filter((q) => q.includes("DELETE"));
    expect(deletes.length).toBeGreaterThan(0);
    for (const q of deletes) {
      expect(q).not.toContain("UNAVAILABLE_AT");
      expect(q).not.toContain("DETACH");
      expect(q).toMatch(/\[\w+:(\w+)/); // always a typed pattern
    }
    expect(Object.keys(E.REL_ENDPOINTS)).not.toContain("UNAVAILABLE_AT");
  });
});

describe("ETL verification", () => {
  it("expects the conflict pairs of the SQL definition", async () => {
    const graph = await buildConflictGraph(pool());
    const exp = await E.expectedCounts(pool(), []);
    const pairs = [...graph.values()].reduce((n, nb) => n + nb.size, 0) / 2;
    expect(exp.relationships.CONFLICTS_WITH).toBe(pairs);
    expect(pairs).toBe(91);
    expect(graph.get("CS301")!.get("CS302")).toBe(25); // 24 shared students + 1 shared faculty
    for (const [a, nb] of graph) for (const [b, n] of nb) expect(graph.get(b)!.get(a)).toBe(n); // symmetric
  });

  it("reports each count difference", () => {
    const exp = { nodes: { Course: 30, Faculty: 20 }, relationships: { TEACHES: 62 } };
    const problems = E.compareCounts(exp, { nodes: { Course: 30, Faculty: 19 }, relationships: {} });
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes("Faculty")) && problems.some((p) => p.includes("TEACHES"))).toBe(true);
    expect(E.compareCounts(exp, exp)).toEqual([]);
  });

  it("helpers", () => {
    const stmts = E.readStatements(E.CONSTRAINTS_FILE);
    expect(stmts.length).toBeGreaterThanOrEqual(15);
    expect(stmts.every((s) => s.startsWith("CREATE"))).toBe(true);
  });

  it("a single-year run verifies every year the graph holds", async () => {
    // Regression: a --year run used to compare the whole graph with MySQL's counts for that year
    // alone, so another year in the graph caused a false MISMATCH. Here the graph "holds" the real
    // year too while only the (empty) test year is reloaded.
    const exp = await E.expectedCounts(pool(), [year, TEST_YEAR]);
    const session = recordingSession((cypher) => {
      if (cypher.includes("DISTINCT s.academic_year")) return [{ y: year }, { y: TEST_YEAR }];
      if (cypher.includes("AS nodes")) return Object.entries(exp.nodes).map(([label, nodes]) => ({ label, nodes }));
      if (cypher.includes("AS relationships"))
        return Object.entries(exp.relationships).map(([rel_type, relationships]) => ({ rel_type, relationships }));
      return [];
    });
    const result = await E.runEtl(TEST_YEAR, { session, log: quiet });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the CLI explains an unreachable Neo4j", async () => {
    const saved = [process.env.NEO4J_URI, process.env.NEO4J_PASSWORD];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((m: string) => void errors.push(m));
    try {
      process.env.NEO4J_URI = "bolt://127.0.0.1:1";
      process.env.NEO4J_PASSWORD = "irrelevant";
      expect(await E.etlMain(["--year", "2001-2002"])).toBe(2);
      expect(errors.join("\n")).toContain("Could not use Neo4j");
    } finally {
      [process.env.NEO4J_URI, process.env.NEO4J_PASSWORD] = saved;
    }
    expect(await E.etlMain(["--bogus"])).toBe(2); // argparse-style usage error
  });
});
