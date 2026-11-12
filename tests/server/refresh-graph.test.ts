/** refreshGraph(): the graph_problem text after a substitution when the ETL fails (ETL mocked, no database). */
import neo4j from "neo4j-driver";
import { describe, expect, it, vi } from "vitest";
import { refreshGraph } from "@/lib/server/api";
import { runEtl } from "@/lib/server/etl";

vi.mock("@/lib/server/etl", () => ({ runEtl: vi.fn() }));

describe("refreshGraph", () => {
  it("is null when the graph matches, else lists the problems", async () => {
    vi.mocked(runEtl).mockResolvedValueOnce({ ok: true, problems: [] } as never);
    expect(await refreshGraph("2026-2027")).toBeNull();
    vi.mocked(runEtl).mockResolvedValueOnce({ ok: false, problems: ["a", "b"] } as never);
    expect(await refreshGraph("2026-2027")).toBe("Neo4j graph does not match MySQL: a; b");
  });

  it("names a Neo4j outage ServiceUnavailable (not the generic Neo4jError)", async () => {
    vi.mocked(runEtl).mockRejectedValueOnce(new neo4j.Neo4jError("Failed to connect to server", "ServiceUnavailable", "08000", ""));
    expect(await refreshGraph("2026-2027")).toBe(
      "MySQL is updated, but refreshing Neo4j failed (ServiceUnavailable: Failed to connect to server).");
  });

  it("uses the error's name otherwise", async () => {
    vi.mocked(runEtl).mockRejectedValueOnce(new TypeError("boom"));
    expect(await refreshGraph("2026-2027")).toBe("MySQL is updated, but refreshing Neo4j failed (TypeError: boom).");
  });
});
