import { describe, expect, it } from "vitest";
import { callProcedure, pool, query, withConnection } from "@/lib/server/db";

describe("db", () => {
  it("returns TIME as HH:MM:SS strings and DECIMAL as numbers", async () => {
    const [slot] = await query(pool(), "SELECT start_time FROM TimeSlot ORDER BY slot_id LIMIT 1");
    expect(slot.start_time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const [r] = await query(pool(), "SELECT CAST(1.5 AS DECIMAL(4,2)) AS d");
    expect(r.d).toBe(1.5);
  });

  it("activates the SQL role of a role account", async () => {
    const [r] = await withConnection((c) => query(c, "SELECT CURRENT_ROLE() AS r"), "faculty");
    expect(r.r).toContain("tt_faculty");
  });

  it("calls stored procedures", async () => {
    const rows = await callProcedure(pool(), "sp_hours_coverage", ["2099-2100"]);
    expect(Array.isArray(rows)).toBe(true);
  });
});
