/** Project hygiene: files, documentation and configuration agree with each other. No database needed. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => existsSync(path.join(ROOT, rel));

const REQUIRED = [
  "README.md", "CONTEXT.md", ".env.example", ".gitignore", "docker-compose.yml", ".github/workflows/ci.yml",
  "package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "middleware.ts", "vitest.config.mts",
  "cypher/constraints.cypher", "cypher/queries.cypher",
  "docker/mysql/00_app_user.sh", "docker/mysql/07_role_accounts.sh",
  "sql/01_schema.sql", "sql/02_migration_improvements.sql", "sql/03_seed_data.sql",
  "sql/04_views_procedures.sql", "sql/05_advanced_sql.sql", "sql/06_auth_roles.sql",
  "lib/server/env.ts", "lib/server/db.ts", "lib/server/utils.ts", "lib/server/generator.ts", "lib/server/auth.ts",
  "lib/server/http.ts", "lib/server/neo4j.ts", "lib/server/etl.ts", "lib/server/api.ts",
  "scripts/generate.ts", "scripts/etl.ts", "scripts/queries.ts", "scripts/hash-password.ts", "scripts/make-seed.ts",
  "docs/er-diagram-chen.png",
];
const SQL_FILES = readdirSync(path.join(ROOT, "sql")).filter((f) => f.endsWith(".sql")).sort();
const NPM_SCRIPTS = ["dev", "build", "start", "lint", "test", "generate", "etl", "queries", "hash-password", "make-seed"];

/** Every .ts / .tsx file below a folder (recursively). */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

it("required files are present", () => {
  expect(REQUIRED.filter((p) => !exists(p)), "missing files (see README 'Project structure')").toEqual([]);
});

it("no Python is left in the repository", () => {
  for (const gone of ["src", "api", "tools", "requirements.txt", "requirements-dev.txt", "pytest.ini", "ruff.toml"])
    expect(exists(gone), `${gone} should be gone`).toBe(false);
  expect(readdirSync(path.join(ROOT, "tests")).filter((f) => f.endsWith(".py"))).toEqual([]);
});

it(".env.example documents every setting the code reads", () => {
  const documented = new Set([...read(".env.example").matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const files = [...sources("lib"), ...sources("scripts"), ...sources("app"), "middleware.ts", "next.config.ts",
    "docker-compose.yml"];
  const code = files.map(read).join("\n");
  const used = new Set(
    [...code.matchAll(/["'`${.]((?:MYSQL|NEO4J|ACADEMIC)_[A-Z_]+|APP_SECRET)\b/g)].map((m) => m[1]),
  );
  expect(used.size).toBeGreaterThan(10); // the scan really finds the settings
  expect([...used].filter((v) => !documented.has(v)).sort(), "not in .env.example").toEqual([]);
  expect(documented.has("API_URL"), "API_URL is gone (no separate API server)").toBe(false);
});

it("secrets are git-ignored but the template is not", () => {
  const lines = read(".gitignore").split(/\r?\n/);
  for (const entry of [".env", "!.env.example", "node_modules/", ".next/"]) expect(lines).toContain(entry);
});

it("package.json has the documented npm scripts", () => {
  const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
  expect(Object.keys(scripts)).toEqual(expect.arrayContaining(NPM_SCRIPTS));
  for (const name of ["generate", "etl", "queries", "hash-password", "make-seed"]) {
    const file = scripts[name].match(/scripts\/[\w-]+\.ts/)?.[0];
    expect(file && exists(file), `npm run ${name} -> ${scripts[name]}`).toBeTruthy();
  }
});

it("every SQL file is loaded by Docker and by CI", () => {
  const compose = read("docker-compose.yml");
  const ci = read(".github/workflows/ci.yml");
  expect(SQL_FILES.length).toBeGreaterThanOrEqual(6);
  for (const name of SQL_FILES) {
    expect(compose, `${name} not mounted`).toContain(`./sql/${name}:/docker-entrypoint-initdb.d/${name}`);
    expect(ci, `${name} not loaded in the MariaDB CI job`).toContain(`sql/${name}`);
  }
  expect(compose).toContain("07_role_accounts.sh:/docker-entrypoint-initdb.d/07_role_accounts.sh");
});

describe("README matches the code", () => {
  const text = read("README.md");

  it("every documented command-line option exists", () => {
    // options of other tools (mariadb-install-db, docker, npm, next, vitest ...)
    const external = new Set(["--now", "--user", "--basedir", "--datadir", "--silent", "--wait", "--port", "--spec",
      "--quiet", "--project", "--noEmit"]);
    // the CLIs declare their options with node:util parseArgs: { name: { type: ... } }
    const code = [...sources("scripts"), "lib/server/etl.ts"].map(read).join("\n");
    const options = new Set(
      [...code.matchAll(/["']?([a-z][a-z-]*)["']?:\s*\{\s*type:\s*"(?:string|boolean)"/g)].map((m) => `--${m[1]}`),
    );
    expect(options).toContain("--allow-partial");
    const flags = new Set([...text.matchAll(/--[a-z][a-zA-Z-]+/g)].map((m) => m[0]));
    expect([...flags].filter((f) => !external.has(f) && !options.has(f)).sort()).toEqual([]);
  });

  it("every `npm run` script exists", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    const used = new Set([...text.matchAll(/npm run ([\w-]+(?::[\w-]+)*)/g)].map((m) => m[1]));
    expect([...used].filter((s) => !(s in scripts))).toEqual([]);
  });

  it("internal links resolve and blocks are balanced", () => {
    const headings = new Set(
      [...text.matchAll(/^#{1,4} (.+)$/gm)].map((m) =>
        m[1].toLowerCase().replace(/[^\w\- ]/g, "").trim().replace(/ /g, "-")),
    );
    const anchors = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(5);
    expect(anchors.filter((a) => !headings.has(a))).toEqual([]);
    expect(text.split("<details>").length).toBe(text.split("</details>").length);
    expect((text.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("every file it names exists", () => {
    const named = [...text.matchAll(
      /`((?:sql|cypher|docker|docs|tests|lib|app|components|scripts|\.github)\/[\w./()[\]-]+\.\w+)`/g,
    )].map((m) => m[1]).filter((rel) => !rel.includes("...")); // sql/08_...sql is an example, not a file
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((rel) => !exists(rel))).toEqual([]);
    const linked = [...text.matchAll(/\]\(((?:docs|sql|lib|app|scripts|cypher)\/[^)#]+)\)/g)].map((m) => m[1]);
    expect(linked.filter((rel) => !exists(rel))).toEqual([]);
  });
});
