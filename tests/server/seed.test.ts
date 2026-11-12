/** sql/03_seed_data.sql must be exactly what scripts/make-seed.ts writes (port of the check in test_project_files.py). */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("seed file is exactly what make-seed generates", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "seed-"));
  try {
    const out = path.join(dir, "seed.sql");
    await promisify(execFile)(path.resolve("node_modules/.bin/tsx"), ["scripts/make-seed.ts", out]);
    expect(readFileSync(out).equals(readFileSync(path.resolve("sql/03_seed_data.sql")))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
