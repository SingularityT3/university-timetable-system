/** Password hashing and signed session tokens (no database). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, makeToken, readToken, verifyPassword } from "@/lib/server/auth";
import { PROJECT_ROOT } from "@/lib/server/env";

const SECRET = "unit-test-secret";
const USER = { user_id: 7, role: "faculty" as const, faculty_id: 3 };
const b64json = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("passwords", () => {
  it("hashes and verifies", () => {
    const h = hashPassword("s3cret pw", 1000);
    expect(h).toMatch(/^pbkdf2_sha256\$1000\$[\w-]+\$[\w-]+$/);
    expect(h).not.toContain("s3cret");
    expect(verifyPassword("s3cret pw", h)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const h = hashPassword("right", 1000);
    for (const pw of ["wrong", "Right", ""]) expect(verifyPassword(pw, h)).toBe(false);
  });

  it("gives every hash its own salt", () => {
    const [a, b] = [hashPassword("same", 1000), hashPassword("same", 1000)];
    expect(a).not.toBe(b);
    expect(verifyPassword("same", a) && verifyPassword("same", b)).toBe(true);
  });

  it("never verifies a malformed hash", () => {
    for (const stored of ["", "garbage", "md5$1000$abc$def", "pbkdf2_sha256$x$abc$def", "pbkdf2_sha256$1000$abc", "pbkdf2_sha256$0$abc$def"])
      expect(verifyPassword("anything", stored)).toBe(false);
  });

  it("matches the hashes the Python code made (same format and algorithm)", () => {
    const salt = Buffer.from("0123456789abcdef");
    // python: auth.hash_password("pw", 1000, b"0123456789abcdef")
    expect(hashPassword("pw", 1000, salt)).toBe("pbkdf2_sha256$1000$MDEyMzQ1Njc4OWFiY2RlZg$g4BiOBrcHGnGTAdCcoA-WrLOFA69L2c9HA5vVpt2o7A");
  });

  it("accepts the seeded demo users' documented passwords", () => {
    const sql = readFileSync(join(PROJECT_ROOT, "sql", "06_auth_roles.sql"), "utf8");
    const seeds = Object.fromEntries([...sql.matchAll(/\('(\w+)',\s+'(pbkdf2_sha256\$[^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(seeds).sort()).toEqual(["admin", "faculty1", "faculty2"]);
    expect(verifyPassword("admin123", seeds.admin)).toBe(true);
    expect(verifyPassword("faculty123", seeds.faculty1) && verifyPassword("faculty123", seeds.faculty2)).toBe(true);
  });
});

describe("session tokens", () => {
  it("round-trips", () => {
    const p = readToken(makeToken(USER, SECRET), SECRET)!;
    expect([p.uid, p.role, p.fid]).toEqual([7, "faculty", 3]);
  });

  it("rejects tampered tokens", () => {
    const token = makeToken(USER, SECRET);
    const [body, sig] = token.split(".");
    const forged = b64json({ ...JSON.parse(Buffer.from(body, "base64url").toString()), role: "admin" });
    expect(readToken(`${forged}.${sig}`, SECRET)).toBeNull(); // payload changed, old signature
    expect(readToken(`${body}.${sig.slice(0, -2)}AA`, SECRET)).toBeNull(); // signature changed
    expect(readToken(token, "another-secret")).toBeNull(); // signed with a different secret
    for (const junk of [null, undefined, "", "no-dot", "a.b.c", "!!.??"]) expect(readToken(junk, SECRET)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const token = makeToken(USER, SECRET, 60, 1_000_000);
    expect(readToken(token, SECRET, 1_000_059)).not.toBeNull();
    expect(readToken(token, SECRET, 1_000_060)).toBeNull();
    expect(readToken(token, SECRET, 2_000_000)).toBeNull();
  });

  it("is the same token format as the Python API", () => {
    // python: auth.make_token({"user_id": 7, "role": "faculty", "faculty_id": 3}, "unit-test-secret", now=1_000_000)
    expect(makeToken(USER, SECRET, 8 * 3600, 1_000_000)).toBe(
      "eyJ1aWQiOjcsInJvbGUiOiJmYWN1bHR5IiwiZmlkIjozLCJleHAiOjEwMjg4MDB9.ldSRTEFkJ9Mb5e7L8lv8sGXIDLjuSjIoLe9JrloCoCE");
  });
});
