/**
 * Password hashing, signed session tokens and AppUser lookup (port of api/auth.py).
 *
 *   Passwords: PBKDF2-HMAC-SHA256, stored as  pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
 *   Sessions:  base64url(json{uid, role, fid, exp}) "." base64url(hmac_sha256), signed with
 *              APP_SECRET and kept in the httpOnly cookie `tt_session` for 8 hours.
 * Users live in the AppUser table (sql/06_auth_roles.sql) and are looked up with the service
 * account; everything else a request does runs on its role account (see db.ts).
 *
 * CLI:  npm run hash-password -- <password>     # hash for a seed row / a new user
 */
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { pool, query, type Role } from "./db";
import { env } from "./env";

export const ALGORITHM = "pbkdf2_sha256";
export const ITERATIONS = 200_000;
export const COOKIE = "tt_session";
export const SESSION_SECONDS = 8 * 3600;

export interface User {
  user_id: number;
  username: string;
  role: Role;
  faculty_id: number | null;
  faculty_name: string | null;
}
type UserRow = User & { password_hash: string; is_active: number };

export interface TokenPayload {
  uid: number;
  role: Role;
  fid: number | null;
  exp: number;
}

// ------------------------------------------------------------------ passwords
const b64 = (raw: Buffer) => raw.toString("base64url");
const unb64 = (text: string) => Buffer.from(text, "base64url");

/** Constant-time comparison of two byte strings (false when the lengths differ). */
function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PBKDF2-SHA256 hash with a random 16-byte salt. */
export function hashPassword(password: string, iterations = ITERATIONS, salt: Buffer = randomBytes(16)): string {
  const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `${ALGORITHM}$${iterations}$${b64(salt)}$${b64(digest)}`;
}

/** True when `password` matches the stored hash (constant-time compare). */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM || !/^\d+$/.test(parts[1])) return false;
  try {
    const got = pbkdf2Sync(password, unb64(parts[2]), Number(parts[1]), 32, "sha256");
    return same(got, unb64(parts[3]));
  } catch {
    return false; // e.g. 0 iterations
  }
}

// ------------------------------------------------------------------- tokens
/** APP_SECRET from the environment / .env; the API refuses to work without one. */
export function appSecret(): string {
  const secret = env("APP_SECRET");
  if (!secret) {
    throw new Error(
      "APP_SECRET is not set. Put a long random string in .env " +
        "(node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\").",
    );
  }
  return secret;
}

const sign = (body: string, secret: string) => b64(createHmac("sha256", secret).update(body).digest());
const nowSeconds = () => Date.now() / 1000;

/** Signed session token for an AppUser row (`now` in seconds, for tests). */
export function makeToken(
  user: Pick<User, "user_id" | "role"> & { faculty_id?: number | null },
  secret: string,
  ttl = SESSION_SECONDS,
  now = nowSeconds(),
): string {
  const payload: TokenPayload = { uid: user.user_id, role: user.role, fid: user.faculty_id ?? null, exp: Math.trunc(now + ttl) };
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, secret)}`;
}

/** The token's payload, or null when it is missing, tampered with or expired. */
export function readToken(token: string | null | undefined, secret: string, now = nowSeconds()): TokenPayload | null {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!same(Buffer.from(sig), Buffer.from(sign(body, secret)))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(unb64(body).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const exp = (payload as { exp?: unknown }).exp ?? 0;
  return typeof exp === "number" && exp > now ? (payload as TokenPayload) : null;
}

// -------------------------------------------------------------------- users
const USER_SQL =
  "SELECT u.user_id, u.username, u.password_hash, u.role, u.faculty_id, u.is_active, " +
  "f.name AS faculty_name FROM AppUser u LEFT JOIN Faculty f ON f.faculty_id = u.faculty_id ";

/** The fields the API returns for a user (never the hash). */
export function publicUser(u: User): User {
  return { user_id: u.user_id, username: u.username, role: u.role, faculty_id: u.faculty_id, faculty_name: u.faculty_name };
}

/** Active AppUser by id (service account), or null. */
export async function getUser(userId: number): Promise<User | null> {
  const [row] = await query<UserRow>(pool(), USER_SQL + "WHERE u.user_id = ? AND u.is_active", [userId]);
  return row ? publicUser(row) : null;
}

/** Check a login; on success record last_login and return the user. */
export async function authenticate(username: string, password: string): Promise<User | null> {
  const [row] = await query<UserRow>(pool(), USER_SQL + "WHERE u.username = ? AND u.is_active", [username]);
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  await query(pool(), "UPDATE AppUser SET last_login = CURRENT_TIMESTAMP WHERE user_id = ?", [row.user_id]);
  return publicUser(row);
}
