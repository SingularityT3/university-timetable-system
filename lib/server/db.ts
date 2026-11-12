/**
 * MySQL access (mysql2). One pool per account:
 *   service  MYSQL_USER        CLI scripts, ETL, login lookup, tests
 *   admin    MYSQL_ADMIN_USER  requests of logged-in admins     (SQL role tt_admin)
 *   faculty  MYSQL_FACULTY_USER requests of logged-in faculty   (SQL role tt_faculty, read-only)
 * A role account has no privileges until its role is active, so every new pooled
 * connection runs SET ROLE first and only then selects the database.
 *
 * Value conventions: TIME -> "HH:MM:SS" string, DECIMAL -> number, DATE/TIMESTAMP -> string.
 */
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { env } from "./env";

export type Role = "admin" | "faculty";
export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Db = Pool | PoolConnection;

const ROLE_ACCOUNTS: Record<Role, { userVar: string; user: string; passwordVar: string; sqlRole: string }> = {
  admin: { userVar: "MYSQL_ADMIN_USER", user: "tt_admin_app", passwordVar: "MYSQL_ADMIN_PASSWORD", sqlRole: "tt_admin" },
  faculty: { userVar: "MYSQL_FACULTY_USER", user: "tt_faculty_app", passwordVar: "MYSQL_FACULTY_PASSWORD", sqlRole: "tt_faculty" },
};

// kept on globalThis so Next.js dev hot reloads do not leak pools
const pools: Map<string, Pool> = ((globalThis as any).__ttPools ??= new Map()); // eslint-disable-line

function createPool(role?: Role): Pool {
  const database = env("MYSQL_DATABASE", "university_timetable")!;
  let user: string | undefined, password: string;
  if (role) {
    const a = ROLE_ACCOUNTS[role];
    if (!a) throw new Error(`role must be undefined, 'admin' or 'faculty', got ${role}`);
    user = env(a.userVar, a.user);
    password = env(a.passwordVar, "")!;
  } else {
    user = env("MYSQL_USER");
    if (!user) throw new Error("MYSQL_USER is not set. Copy .env.example to .env and fill it in.");
    password = env("MYSQL_PASSWORD", "")!;
  }
  const socket = env("MYSQL_UNIX_SOCKET");
  const pool = mysql.createPool({
    user,
    password,
    ...(socket ? { socketPath: socket } : { host: env("MYSQL_HOST", "127.0.0.1"), port: Number(env("MYSQL_PORT", "3306")) }),
    ...(role ? {} : { database }),
    charset: "utf8mb4",
    dateStrings: true,
    decimalNumbers: true,
    connectionLimit: 5,
  });
  if (role) {
    // runs before any query of the caller on this connection (mysql2 queues commands)
    pool.pool.on("connection", (c) => {
      c.query(`SET ROLE ${ROLE_ACCOUNTS[role].sqlRole}`);
      c.query(`USE \`${database}\``);
    });
  }
  return pool;
}

/** The shared pool of the service account (no role) or of a role account. */
export function pool(role?: Role): Pool {
  const key = role ?? "service";
  let p = pools.get(key);
  if (!p) {
    p = createPool(role);
    pools.set(key, p);
  }
  return p;
}

/** Borrow one connection (needed for transactions); always released. */
export async function withConnection<T>(fn: (c: PoolConnection) => Promise<T>, role?: Role): Promise<T> {
  const c = await pool(role).getConnection();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Run a statement and return its rows as plain objects. */
export async function query<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

/** CALL a stored procedure and return the rows of its first result set. */
export async function callProcedure(db: Db, name: string, args: unknown[] = []): Promise<Row[]> {
  const [res] = await db.query(`CALL ${name}(${args.map(() => "?").join(", ")})`, args);
  return Array.isArray(res) && Array.isArray(res[0]) ? (res[0] as Row[]) : [];
}

/** BEGIN; fn; COMMIT -- or ROLLBACK and rethrow on any error. */
export async function transaction<T>(c: PoolConnection, fn: () => Promise<T>): Promise<T> {
  await c.beginTransaction();
  try {
    const out = await fn();
    await c.commit();
    return out;
  } catch (e) {
    await c.rollback();
    throw e;
  }
}

/** Close every pool (scripts and tests call this so the process can exit). */
export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
