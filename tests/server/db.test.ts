import { describe, expect, it } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { callProcedure, closePools, pool, query, transaction, withConnection } from "@/lib/server/db";

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

// db.ts helpers with stand-in connection objects
describe("db helpers without a database", () => {
  const fakeConn = () => {
    const calls: string[] = [];
    const c = { calls, beginTransaction: async () => void calls.push("begin"), commit: async () => void calls.push("commit"),
      rollback: async () => void calls.push("rollback") };
    return c as typeof c & PoolConnection;
  };

  it("transaction commits on success", async () => {
    const c = fakeConn();
    expect(await transaction(c, async () => 5)).toBe(5);
    expect(c.calls).toEqual(["begin", "commit"]);
  });

  it("transaction rolls back and rethrows", async () => {
    const c = fakeConn();
    await expect(transaction(c, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(c.calls).toEqual(["begin", "rollback"]);
  });

  it("callProcedure returns the first result set", async () => {
    let sent: unknown[] = [];
    const db = { query: async (...args: unknown[]) => ((sent = args), [[[{ a: 1 }], [{ b: 2 }], { affectedRows: 0 }]]) };
    expect(await callProcedure(db as unknown as PoolConnection, "sp_x", ["2026-2027"])).toEqual([{ a: 1 }]);
    expect(sent).toEqual(["CALL sp_x(?)", ["2026-2027"]]);
  });

  it("the service pool needs MYSQL_USER", async () => {
    const saved = process.env.MYSQL_USER;
    await closePools();
    process.env.MYSQL_USER = "";
    try {
      expect(() => pool()).toThrow("MYSQL_USER");
    } finally {
      process.env.MYSQL_USER = saved;
    }
  });
});
