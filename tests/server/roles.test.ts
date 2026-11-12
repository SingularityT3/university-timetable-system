/**
 * Database-level RBAC (sql/06_auth_roles.sql + docker/mysql/07_role_accounts.sh): the API's role
 * accounts get exactly their SQL role's privileges. Writes only happen in rolled-back transactions.
 */
import mysql from "mysql2/promise";
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { callProcedure, pool, query, type Role } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { realYear, TEST_YEAR } from "./helpers";

const READABLE = ["Department", "Faculty", "Course", "Classroom", "Section", "Student", "TimeSlot", "Teaches",
  "Enrollment", "Timetable", "Section_Course", "v_section_timetable", "v_faculty_timetable"];
const DENIED = 1142; // "command denied to user ... for table ..."

/** Run fn on a role-account connection inside a transaction that is always rolled back. */
async function asRole<T>(role: Role, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool(role).getConnection();
  try {
    await c.beginTransaction();
    return await fn(c);
  } finally {
    await c.rollback();
    c.release();
  }
}

/** The errno of the error `p` rejects with. */
async function errnoOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { errno?: number }).errno;
  }
  throw new Error("expected the statement to fail");
}

describe("SQL roles", () => {
  it("runs each account with its role", async () => {
    expect((await asRole("faculty", (c) => query(c, "SELECT CURRENT_ROLE() AS r")))[0].r).toContain("tt_faculty");
    expect((await asRole("admin", (c) => query(c, "SELECT CURRENT_ROLE() AS r")))[0].r).toContain("tt_admin");
  });

  it("gives a role account no privileges until the role is set", async () => {
    const socket = env("MYSQL_UNIX_SOCKET");
    const connect = mysql.createConnection({
      user: env("MYSQL_FACULTY_USER", "tt_faculty_app"), password: env("MYSQL_FACULTY_PASSWORD", ""),
      database: env("MYSQL_DATABASE", "university_timetable"),
      ...(socket ? { socketPath: socket } : { host: env("MYSQL_HOST", "127.0.0.1"), port: Number(env("MYSQL_PORT", "3306")) }),
    });
    expect(await errnoOf(connect.then((c) => c.end()))).toBe(1044); // not even the database is visible
  });

  it("lets the faculty role read the timetable", async () => {
    await asRole("faculty", async (c) => {
      for (const table of READABLE) await query(c, `SELECT COUNT(*) AS n FROM ${table}`);
      expect((await callProcedure(c, "sp_faculty_workload", [realYear()])).length).toBeGreaterThan(0);
      expect((await query(c, "SELECT fn_faculty_load(1, ?) AS n", [realYear()]))[0].n).toBeGreaterThanOrEqual(0);
    });
  });

  it.each([
    "INSERT INTO Department (dept_name, building) VALUES ('Role Test Dept', 'X')",
    "UPDATE Timetable SET room_id = room_id WHERE academic_year = 'no-year'",
    "DELETE FROM Teaches WHERE faculty_id = -1",
    "SELECT * FROM AppUser",
  ])("denies the faculty role writes and the user table: %s", async (sql) => {
    expect(await asRole("faculty", (c) => errnoOf(query(c, sql)))).toBe(DENIED);
  });

  it("lets the admin role write", async () => {
    const affected = async (c: PoolConnection, sql: string, params: unknown[] = []) =>
      ((await c.query(sql, params))[0] as mysql.ResultSetHeader).affectedRows;
    await asRole("admin", async (c) => {
      expect(await affected(c, "INSERT INTO Department (dept_name, building) VALUES ('Role Test Dept', 'X')")).toBe(1);
      expect(await affected(c, "UPDATE Department SET building = 'Y' WHERE dept_name = 'Role Test Dept'")).toBe(1);
      expect(await affected(c, "DELETE FROM Department WHERE dept_name = 'Role Test Dept'")).toBe(1);
      expect(await affected(c, "DELETE FROM Timetable WHERE academic_year = ?", [TEST_YEAR])).toBeGreaterThanOrEqual(0);
      expect(Number((await query(c, "SELECT COUNT(*) AS n FROM AppUser"))[0].n)).toBeGreaterThanOrEqual(1);
    });
    expect(await query(pool(), "SELECT 1 AS x FROM Department WHERE dept_name = 'Role Test Dept'")).toEqual([]);
  });

  it("gives the admin role no DDL", async () => {
    try {
      expect(await asRole("admin", (c) => errnoOf(query(c, "CREATE TABLE role_test_tmp (x INT)")))).toBe(DENIED);
    } finally { // only if the test failed: remove the table again
      await query(pool(), "DROP TABLE IF EXISTS role_test_tmp");
    }
  });
});
