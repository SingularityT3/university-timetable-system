# University Timetable Generation System

A DBMS mini-project that **automatically generates a clash-free university timetable** and lets you
query and visualise it. **MySQL** is the system of record (schema, constraints, triggers, views,
stored procedures); **Neo4j** is a graph layer for relationship-heavy analytics (who can substitute
for an absent teacher, which courses collide, what happens if a class moves); a single **Next.js**
application written in **TypeScript** (pages + API route handlers + command-line scripts) ties it
together, with logins and two roles enforced inside MySQL.

- [Features](#features) · [Architecture](#architecture) · [Project structure](#project-structure)
- [Quick start](#quick-start) · [Detailed setup](#detailed-setup) · [Running the system](#running-the-system)
- [Using the web app](#using-the-web-app) · [Authentication and role-based access](#authentication-and-role-based-access)
- [How it works](#how-it-works) · [Advanced SQL](#advanced-sql-function-cte-recursive-cte) · [Neo4j RUD](#neo4j-read-update-delete-the-graph-page)
- [Configuration](#configuration-reference) · [Verify your installation](#verify-your-installation) · [Troubleshooting](#troubleshooting)
- [Tests](#tests) · [Status and limitations](#status-and-limitations) · [Working in a team](#working-in-a-team)

---

## Features

| Area | What you get |
|---|---|
| **Relational core (MySQL)** | 11 tables from the supplied ER diagram + `AppUser`, `UNIQUE` keys that make double-booking impossible, composite foreign keys (a teacher can only be timetabled for a course they teach, a section only for courses in its plan), triggers for room capacity and room type, 4 views, 7 stored procedures and a stored function |
| **Advanced SQL** | `fn_faculty_load` (stored function), `sp_department_summary` (several CTEs + a window function), `sp_free_blocks` (recursive CTE): see [Advanced SQL](#advanced-sql-function-cte-recursive-cte) |
| **Scheduler (TypeScript)** | Greedy "most constrained first" ordering + backtracking + randomised restarts. Hard constraints always hold; soft ones (spread across days, no long teaching runs, labs in consecutive periods) are best effort. Reports exactly what could not be placed and why. All-or-nothing saves in one transaction |
| **Graph analytics (Neo4j)** | Idempotent MySQL → Neo4j export; derived `CONFLICTS_WITH` between courses; 12 documented analytic Cypher queries (impact of an absence, substitute finder, free rooms, shortest path between teachers, ripple effect of moving a class ...) plus read / update / delete queries for the Graph page (node browser, faculty unavailability marks) |
| **Web app (Next.js)** | Login, weekly grids per section / faculty / room with free blocks, generator control panel, "faculty absent" tool (with one-click substitute assignment and undo), clash checker (incl. "would this class be allowed?" what-if), statistics with a department summary, Neo4j graph browser and unavailability editor, CSV downloads |
| **Authentication and roles** | `AppUser` table with PBKDF2 password hashes, signed httpOnly session cookie, roles **admin** and **faculty**. Each request runs on a MySQL account that holds only the matching SQL role (`tt_admin` / `tt_faculty`), so the database itself refuses a faculty write |
| **Seed data** | 3 departments, 20 faculty, 30 courses (24 theory + 6 lab), 10 sections, 120 students, 25 rooms, 48 time slots, 600 enrollments, all deliberately feasible; 3 demo logins |

## Architecture

```
          ┌──────────────────────────────────────────────────┐
browser ─►│ Next.js app (one Node.js server, port 3000)      │
          │                                                  │
          │  pages (React)        login · timetable · generator · absent
          │  app/(main)/, login/  clash checker · statistics · graph
          │        │ fetch /api/* (same origin, httpOnly cookie tt_session)
          │        ▼                                         │
          │  API route handlers   app/api/**/route.ts: login, roles, JSON routes
          │        │ lib/server/: generator, ETL, Neo4j queries, auth, db
          └────────┼───────────────────────┬─────────────────┘
  SQL as tt_admin  │ or tt_faculty         │ Cypher (12 analytic queries + graph RUD)
   (SET ROLE)      │                       │
        ┌──────────▼──────────────┐  ETL   ┌▼───────────────────────┐
        │ MySQL / MariaDB         │ ─────► │ Neo4j (graph)          │
        │ system of record        │ lib/   │ analytics, paths,      │
        │ constraints · triggers  │ server/│ conflicts, substitutes,│
        │ roles · AppUser         │ etl.ts │ unavailability marks   │
        └──────────▲──────────────┘        └────────────────────────┘
                   │ reads data, writes Timetable
         ┌─────────┴──────────────────────┐
         │ npm run generate / etl /       │  the same lib/server/ code from the command line
         │ queries (scripts/*.ts via tsx) │  (the generator also runs from the web app)
         └────────────────────────────────┘
```

**Rule of thumb:** MySQL always holds the truth. Neo4j is a *derived copy*: after you regenerate
a timetable, refresh it with the ETL (the web app has a button for it). The one exception is the faculty
unavailability marks, which live only in Neo4j (see [Neo4j RUD](#neo4j-read-update-delete-the-graph-page)).

**Tech stack:** MySQL 8.x (also works on MariaDB) · Neo4j 5.x (Cypher) · Node.js 22 with Next.js 15, React 19 and
TypeScript, `mysql2` and the official `neo4j-driver` (one language for the pages, the API, the scheduler, the ETL
and the CLI tools; tests: Vitest + Testing Library) · Docker Compose (optional).

## Project structure

```
university-timetable-system/
├── README.md                     this file
├── CONTEXT.md                    project handoff notes (decisions, status, environment quirks)
├── package.json                  dependencies and npm scripts (dev, build, start, lint, test, generate, etl ...)
├── package-lock.json             exact dependency versions (npm ci)
├── tsconfig.json                 TypeScript settings (strict)
├── next.config.ts                Next.js settings (mysql2 / neo4j-driver stay server-side)
├── middleware.ts                 sends visitors without a session to /login
├── vitest.config.mts             test projects: ui (jsdom) and server (Node, real databases)
├── docker-compose.yml            MySQL 8 + Neo4j 5 containers (optional)
├── .github/workflows/ci.yml      GitHub Actions: lint, tests + build on MySQL 8/Neo4j 5 and on MariaDB
├── .env.example                  settings template -> copy to .env
├── .gitignore
├── app/                          Next.js App Router
│   ├── login/, (main)/           pages: login, timetable, generator, absent, clashes, statistics, graph
│   └── api/**/route.ts           the JSON API: auth, meta, timetable, generator, ETL, absence, graph ...
├── components/                   WeekGrid, DataTable, BarChart, Sidebar, Metric, Alert ...
├── lib/
│   ├── api.ts, types.ts, csv.ts  browser side: typed API client, response types, CSV export
│   └── server/                   server side only (API routes, scripts, tests)
│       ├── env.ts                settings from .env / the environment
│       ├── db.ts                 MySQL pools (service account, role accounts + SET ROLE), transactions
│       ├── utils.ts              error translation, slot geometry, conflict graph, grid builder
│       ├── generator.ts          the scheduler (+ "check a proposed class", substitute assignment)
│       ├── etl.ts                MySQL -> Neo4j export, verification
│       ├── neo4j.ts              driver, the Cypher queries from cypher/queries.cypher, wrappers
│       ├── auth.ts               PBKDF2 hashing, signed session tokens, AppUser lookup
│       ├── http.ts               route helpers: login/role checks, validation, error -> HTTP status
│       └── api.ts                logic shared by several routes
├── scripts/                      command-line tools (run with npm run <name>)
│   ├── generate.ts               npm run generate: build the timetable
│   ├── etl.ts                    npm run etl: copy MySQL into Neo4j
│   ├── queries.ts                npm run queries: list | demo | check
│   ├── hash-password.ts          npm run hash-password: PBKDF2 hash for a new AppUser row
│   └── make-seed.ts              npm run make-seed: regenerates sql/03_seed_data.sql (optional)
├── sql/
│   ├── 01_schema.sql             original DDL from the PDF (unchanged)
│   ├── 02_migration_improvements.sql   every improvement, flagged M1-M6
│   ├── 03_seed_data.sql          sample data (generated by scripts/make-seed.ts)
│   ├── 04_views_procedures.sql   4 views + 4 procedures
│   ├── 05_advanced_sql.sql       stored function, CTE procedure, recursive-CTE procedure
│   └── 06_auth_roles.sql         AppUser table + demo logins, SQL roles tt_admin / tt_faculty
├── cypher/
│   ├── constraints.cypher        uniqueness constraints and indexes
│   └── queries.cypher            the documented queries (single source of truth)
├── docker/mysql/
│   ├── 00_app_user.sh            creates the app (service) DB user inside the container
│   └── 07_role_accounts.sh       creates the two role login accounts used by the API routes
├── docs/er-diagram-chen.png      the Chen ER diagram as a rendered image
└── tests/                        automated test suite, Vitest (see "Tests")
    ├── ui/                       components and pages with a mocked fetch (jsdom, no servers)
    └── server/                   database, scheduler, API routes, roles, ETL and Neo4j, project files
```

---

## Quick start

Fastest path **with Docker** (any OS with Docker Desktop / Docker Engine) and **Node.js 22**:

```bash
git clone https://github.com/Shashankb30/university-timetable-system.git university-timetable-system && cd university-timetable-system
cp .env.example .env                    # then edit: set MYSQL_PORT=3307, your passwords and APP_SECRET
docker compose up -d --wait             # MySQL + Neo4j (schema, seed, roles and logins load automatically)
npm ci                                  # install the exact dependency versions
npm run generate -- --replace           # build the timetable
npm run etl                             # copy it into the graph
npm run dev                             # open http://localhost:3000 and log in as admin / admin123
```

That is the whole system: one Next.js server serves the pages **and** the JSON API (`/api/*`); there is no
second process to start. No Docker? Follow [Option B: native installs](#option-b-native-installs-no-docker).

---

## Detailed setup

### 1. Prerequisites

| Component | Needed for | Version | Notes |
|---|---|---|---|
| Node.js + npm | everything (web app, API, scheduler, ETL, tests) | Node **22** LTS (tested on 22.23 / npm 10) | <https://nodejs.org/> or your package manager (`nvm install 22`) |
| MySQL **or** MariaDB | the database | MySQL 8.0.16+ (older versions silently ignore `CHECK` constraints) · MariaDB recent | Not needed if you use Docker |
| Neo4j Community | graph layer | 5.7+ (tested on **5.26.0**) | Needs **Java 17 or 21** for native installs; not needed with Docker |
| Docker + Compose | optional shortcut | any recent | Runs MySQL and Neo4j for you |
| Git | cloning | any | |

No Python is needed: the whole project is TypeScript.

**Platform support:** developed and verified on Linux (Ubuntu/MySQL 8.0 for automated checks, Arch Linux with
MariaDB and Neo4j 5.26.0 on the author's machine). The macOS, Windows and Docker instructions follow the official
documentation of each tool but have **not** been run by the author; they are marked below. Windows users
get the smoothest experience in **WSL 2 (Ubuntu)**: follow the Linux steps there.

### 2. Get the code

```bash
git clone https://github.com/Shashankb30/university-timetable-system.git university-timetable-system
cd university-timetable-system
```

### 3. Install the dependencies

From the project root (the same command on every OS and shell):

```bash
node -v                            # must print v22.x
npm ci                             # installs exactly what package-lock.json lists into node_modules/
```

`npm ci` is needed once, and again after `package-lock.json` changes. The command-line tools run TypeScript
directly through `tsx` (a dev dependency), so there is no separate compile step.

### 4. Configure the settings (`.env`)

All credentials and options live in a `.env` file in the project root. It is read by the Next.js server, by
every `npm run` script and by the tests, **in every shell** (no `export` / `set -x` needed) and is git-ignored.

```bash
cp .env.example .env               # Windows PowerShell: Copy-Item .env.example .env
```

Open `.env` and set your own passwords and a random `APP_SECRET`
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`). The most important lines are
explained in [Configuration reference](#configuration-reference). Real environment variables override the file.

### 5. Databases

#### Option A: Docker

```bash
docker compose up -d --wait        # returns once both containers are healthy; first start takes ~30-60 s
docker compose ps                  # both should show (healthy)
```

- MySQL is published on host port **3307** (so it cannot clash with a MySQL/MariaDB already on your
  machine): set `MYSQL_PORT=3307` in `.env`.
- On the first start the container creates the app user, loads `sql/01` → `06` automatically
  (schema, improvements, seed data, views/procedures, advanced SQL, logins and SQL roles) and then creates the
  two role accounts with `docker/mysql/07_role_accounts.sh`. **You do not run the SQL files yourself.**
  The init scripts only run on an empty volume: after pulling new SQL files run `docker compose down -v` once.
- Neo4j (Browser at <http://localhost:7474>, Bolt on 7687) starts with the password from
  `NEO4J_PASSWORD` in `.env` (8+ characters).
- Stop: `docker compose down` · Wipe all data and start fresh: `docker compose down -v`.

*(Verified with Docker 29 / Compose 5. CI starts this exact stack on every pull request and runs the
whole test suite against it.)*

#### Option B: native installs (no Docker)

**B1. MySQL or MariaDB**

<details><summary><b>Ubuntu / Debian</b></summary>

```bash
sudo apt update
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```
</details>

<details><summary><b>Fedora</b></summary>

```bash
sudo dnf install -y community-mysql-server
sudo systemctl enable --now mysqld
```
</details>

<details><summary><b>Arch Linux (MariaDB, verified by the author)</b></summary>

```bash
sudo pacman -S mariadb
sudo mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql
sudo systemctl enable --now mariadb
```
The `mysql` command here is MariaDB's client (it prints a "deprecated program name" notice). The root
account uses socket authentication: use `sudo mariadb` instead of `mysql -u root -p`.
</details>

<details><summary><b>macOS (Homebrew) <i>(not tested by the author)</i></b></summary>

```bash
brew install mysql
brew services start mysql
```
Root has no password initially: `mysql -u root`.
</details>

<details><summary><b>Windows <i>(not tested by the author)</i></b></summary>

Install "MySQL Community Server 8.0" from <https://dev.mysql.com/downloads/mysql/> (or
`winget install Oracle.MySQL`), choose a root password in the installer and make sure the `mysql`
client is on your `PATH`. Or use WSL 2 and follow the Ubuntu steps.
</details>

**B2. Create the application user** (run as the database administrator; pick your own password,
the same one you put in `.env`):

```bash
# Linux/MySQL: sudo mysql      Arch/MariaDB: sudo mariadb      macOS: mysql -u root      Windows/other: mysql -u root -p
sudo mysql
```
```sql
CREATE USER IF NOT EXISTS 'timetable'@'localhost' IDENTIFIED BY 'change_me_timetable';
CREATE USER IF NOT EXISTS 'timetable'@'127.0.0.1' IDENTIFIED BY 'change_me_timetable';
GRANT ALL PRIVILEGES ON university_timetable.* TO 'timetable'@'localhost';
GRANT ALL PRIVILEGES ON university_timetable.* TO 'timetable'@'127.0.0.1';
FLUSH PRIVILEGES;
```

**B3. Load the database.** Run from the project root, in this order. The `source` form below works on
every OS and shell (including Windows PowerShell, where `< file.sql` does not work) and understands the
`DELIMITER` lines used by the trigger and procedure files:

```bash
# use the same admin command as above in place of "sudo mysql"
sudo mysql -e "source sql/01_schema.sql"
sudo mysql -e "source sql/02_migration_improvements.sql"
sudo mysql -e "source sql/03_seed_data.sql"
sudo mysql -e "source sql/04_views_procedures.sql"
sudo mysql -e "source sql/05_advanced_sql.sql"
sudo mysql -e "source sql/06_auth_roles.sql"
```

Run each file **once** (`01` and `02` fail if repeated: to start over run
`DROP DATABASE university_timetable;` first). Re-running `03_seed_data.sql` is safe: it empties the
tables first, **including the timetable** (but not `AppUser`). `04`, `05` and `06` can be re-run.

**B3b. Create the API's role accounts** (what `docker/mysql/07_role_accounts.sh` does in Docker). Use the
names and passwords from `MYSQL_ADMIN_*` / `MYSQL_FACULTY_*` in `.env`; on a local server use `'localhost'`
and `'127.0.0.1'` as for the app user (shown for `'localhost'`):

```sql
CREATE USER IF NOT EXISTS 'tt_admin_app'@'localhost' IDENTIFIED BY 'change_me_admin_app';
CREATE USER IF NOT EXISTS 'tt_faculty_app'@'localhost' IDENTIFIED BY 'change_me_faculty_app';
GRANT tt_admin TO 'tt_admin_app'@'localhost';
GRANT tt_faculty TO 'tt_faculty_app'@'localhost';
```

The accounts get **no direct privileges**, only their role; the API activates it with `SET ROLE` on every connection.

**B4. Neo4j (native).** Neo4j 5 needs Java 17 or 21.

<details><summary><b>Install Java 21</b></summary>

| OS | Command |
|---|---|
| Ubuntu / Debian | `sudo apt install -y openjdk-21-jre-headless` |
| Fedora | `sudo dnf install -y java-21-openjdk-headless` |
| Arch | `sudo pacman -S jre21-openjdk-headless && sudo archlinux-java set java-21-openjdk` |
| macOS | `brew install openjdk@21` (then follow the "link" note brew prints) |
| Windows | `winget install EclipseAdoptium.Temurin.21.JDK` |

Check with `java -version`: it must report 17 or 21.
</details>

<details><summary><b>Linux / macOS: download and start Neo4j 5.26</b></summary>

```bash
mkdir -p ~/neo4j && cd ~/neo4j
curl -O https://dist.neo4j.org/neo4j-community-5.26.0-unix.tar.gz
tar -xzf neo4j-community-5.26.0-unix.tar.gz
cd neo4j-community-5.26.0

# FIRST, before the very first start, set the password (8+ characters):
bin/neo4j-admin dbms set-initial-password change_me_neo4j

bin/neo4j console          # runs in the foreground; leave this terminal open. Ctrl+C stops it
# or:  bin/neo4j start | status | stop     (background)
```
</details>

<details><summary><b>Windows (PowerShell) <i>(not tested by the author)</i></b></summary>

```powershell
Invoke-WebRequest https://dist.neo4j.org/neo4j-community-5.26.0-windows.zip -OutFile neo4j.zip
Expand-Archive neo4j.zip -DestinationPath .
cd neo4j-community-5.26.0
bin\neo4j-admin dbms set-initial-password change_me_neo4j
bin\neo4j console
```
If a download link has moved, get Neo4j 5.26 Community from <https://neo4j.com/deployment-center/>.
</details>

When the log shows `Started.`, Neo4j is up: Browser at <http://localhost:7474> (user `neo4j`), Bolt on port
7687. The password must equal `NEO4J_PASSWORD` in `.env`. The newest Neo4j releases use calendar versions
(e.g. 2025.x); this project was verified on **5.26.0**.

---

## Running the system

All commands run from the project root. Arguments for a script go after `--` (npm's separator).

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run generate` | Builds the timetable for `ACADEMIC_YEAR` and saves it (add `-- --replace` to overwrite) |
| 2 | `npm run etl` | Copies MySQL data + timetable into Neo4j and verifies the counts |
| 3 | `npm run queries -- demo` | Runs every Cypher query and prints results |
| 4 | `npm run dev` | The web app **and** its API at <http://localhost:3000> (development server, reloads on save) |

For a production-style run: `npm run build && npm run start` (also port 3000; the API routes are part of the same
server). `npm ci` is only needed once (and after `package-lock.json` changes).

### Command-line reference

**`npm run generate`**: the scheduler (`scripts/generate.ts`)

```bash
npm run generate -- --dry-run                 # compute and report only, write nothing
npm run generate -- --replace                 # overwrite an existing timetable for the year
npm run generate -- --allow-partial           # keep a clash-free partial result if a complete one is impossible
npm run generate -- --year 2027-2028 --seed 7 --time-limit 60 --restarts 6
npm run generate -- --max-nodes 500000        # search budget per attempt (default 300000)
```

| Option | Default | Meaning |
|---|---|---|
| `--year YEAR` | `ACADEMIC_YEAR` | Academic year to build |
| `--replace` | off | Delete and rebuild an existing timetable for the year (otherwise it refuses) |
| `--allow-partial` | off | Save a clash-free partial result when a complete one is not found |
| `--dry-run` | off | Report only; nothing is written |
| `--time-limit S` | `30` | Seconds of search in total |
| `--max-nodes N` | `300000` | Search nodes per attempt |
| `--restarts N` | `4` | Randomised restarts (`0` = one attempt) |
| `--seed N` | `42` | Random seed: the same seed gives the same timetable |

Exit code `0` on success, `1` when no complete timetable was saved, `2` when MySQL is unreachable or an argument is
wrong.

**`npm run etl`**: MySQL → Neo4j (`scripts/etl.ts`)

```bash
npm run etl                        # every academic year in Timetable
npm run etl -- --year 2026-2027    # refresh only one year
npm run etl -- --reset             # wipe the graph first, then rebuild (also deletes the unavailability marks)
```
Exit code `0` when the graph matches MySQL, `1` on a mismatch, `2` when MySQL or Neo4j is unreachable.

**`npm run queries`**: the documented Cypher queries (`scripts/queries.ts`)

```bash
npm run queries -- check      # which NEO4J_* settings are used (password masked) + a real login test
npm run queries -- list       # the available queries
npm run queries -- demo       # run every query with sample inputs
```

**`npm run hash-password`** and **`npm run make-seed`**

```bash
npm run hash-password -- 'new-password'      # print a PBKDF2 hash for a new AppUser row
npm run make-seed                            # rewrite sql/03_seed_data.sql (deterministic; optional)
npm run make-seed -- /tmp/seed.sql           # ... or write it somewhere else
```

**Development**

```bash
npm run dev -- --port 3001     # another port
npm run lint                   # TypeScript type check (tsc --noEmit)
npm test                       # the test suite (see Tests)
```

> **Windows/Docker note:** the web app and the CLI tools run on your machine and talk to the databases over
> `localhost`; only the databases live in containers.

---

## Using the web app

Start the web app (`npm run dev`, step 4 above) and open <http://localhost:3000>. You land on the
**login page**. The seed data (`sql/06_auth_roles.sql`) has three demo accounts:

| Username | Password | Role | Linked faculty member |
|---|---|---|---|
| `admin` | `admin123` | admin | none |
| `faculty1` | `faculty123` | faculty | faculty 1 (CSE) |
| `faculty2` | `faculty123` | faculty | faculty 11 (ECE) |

Change these passwords (or deactivate the accounts) before the app is reachable by anyone else.

The sidebar selects the **academic year** and the page, shows who is logged in (with a role badge and
**Logout**) and whether MySQL and Neo4j are connected, and how many classes are saved for the year. Pages marked
*admin* are hidden for faculty users, and the API refuses them anyway (HTTP 403).

| Page | What it does |
|---|---|
| **Timetable** | Weekly grid for a **section**, **faculty member** or **room** (theory blue, lab orange, lunch and breaks shown). Metrics and a CSV download. For a teacher or a room it also lists the **free blocks** (from the recursive CTE `sp_free_blocks`). A faculty user starts on their own timetable |
| **Run generator** *(admin)* | Year, "replace existing", dry run, partial save, time limit, seed. Shows the verdict, soft-constraint counts, anything unplaced and why. After saving it offers **Update Neo4j graph** |
| **Faculty absent** *(needs Neo4j)* | Pick a teacher and a day (or whole week): classes affected, students and sections hit, and per-class substitutes. **Qualified** = teaches that course (assignable directly); **Related** = teaches a colliding course (needs a `Teaches` row first). Teachers marked unavailable in that slot on the Graph page are not suggested. *Admin:* **Assign** hands a class to the chosen substitute in the saved weekly timetable (for a Related candidate, tick the box to add the `Teaches` row in the same transaction), then refreshes the Neo4j graph; **Undo** reverses it, including the added `Teaches` row. Warns when the graph is out of date (compares classes per teacher, so a reassignment is noticed). CSV download |
| **Clash checker** | (1) audit the saved timetable (`sp_list_clashes`, `sp_hours_coverage`); (2) test a hypothetical class against every rule without saving it; (3) *Move a class*: ripple effect through Neo4j |
| **Statistics** | Faculty workload, room utilisation, classes per day/period, theory vs lab, section load, the **department summary** (the CTE procedure `sp_department_summary`), plus graph insights from Neo4j |
| **Graph (Neo4j)** | Node browser (any of the 7 labels, search by id or name, click a node to see its neighbours) and the **faculty unavailability** editor: list marks (everyone), add, edit the reason or delete (*admin*). See [Neo4j RUD](#neo4j-read-update-delete-the-graph-page) |

If Neo4j is not running, only the Neo4j-backed parts show a message; everything else keeps working.

### What each role can do

| | admin | faculty |
|---|---|---|
| View every timetable, free blocks, clashes, statistics, absence plans, ripple checks, the graph | yes | yes |
| "Check a proposed class" (read-only what-if) | yes | yes |
| Run the generator, update the Neo4j graph (ETL) | yes | no (403) |
| Assign / undo a substitute | yes | no (403) |
| Add, edit or delete unavailability marks | yes | no (403) |
| Read the `AppUser` table in MySQL | yes (`tt_admin`) | no: MySQL error 1142 |
| `INSERT` / `UPDATE` / `DELETE` anything in MySQL | yes (`tt_admin`) | no: MySQL error 1142 |

---

## Authentication and role-based access

Access control is enforced in three layers, from the outside in:

1. **Pages** (`middleware.ts`): a visitor without the session cookie is sent to `/login`; admin-only
   links and buttons are hidden for faculty users. This is convenience only.
2. **API route handlers** (`app/api/**/route.ts`, checks in `lib/server/http.ts`): every route except
   `/api/auth/login`, `/api/auth/logout` and `/api/health` needs a valid session (otherwise **401**); generator,
   ETL, substitutions and unavailability writes need the admin role (otherwise **403**).
3. **Database** (`sql/06_auth_roles.sql`): each request talks to MySQL on an account that holds **only** the
   SQL role of the logged-in user. Even a bug in the API cannot make a faculty request write.

**Users (`AppUser`).** One row per login: `user_id`, `username` (unique), `password_hash`, `role`
(`admin` | `faculty`), `faculty_id` (FK to `Faculty`), `is_active`, `created_at`, `last_login`. A `CHECK`
constraint requires a faculty login to be linked to a `Faculty` row (`role = 'admin' OR faculty_id IS NOT NULL`);
that link is how the app knows "my timetable".

**Passwords.** PBKDF2-HMAC-SHA256 from Node's built-in `crypto` module (`pbkdf2Sync`), 200 000
iterations, a random 16-byte salt per password, stored as `pbkdf2_sha256$<iterations>$<salt>$<hash>` and
compared in constant time (`timingSafeEqual`); see `lib/server/auth.ts`. `npm run hash-password -- <password>`
prints a hash for a new row. Plain-text passwords are never stored.

**Sessions.** `POST /api/auth/login` sets the cookie `tt_session`: a token `base64(json{uid, role, fid, exp})`
followed by an HMAC-SHA256 signature made with `APP_SECRET`. The cookie is `httpOnly` (JavaScript cannot read
it), `SameSite=Lax` and expires after 8 hours. On every request the API checks the signature and the expiry and
re-reads the user, so a deactivated account is locked out at once. Without `APP_SECRET` the API refuses to
log anyone in. Pages and API share one origin (the Next.js server), so the cookie stays first-party and no CORS
setup is needed.

**SQL roles.** `06_auth_roles.sql` creates two roles and `docker/mysql/07_role_accounts.sh` creates one login
account per role, with no direct privileges:

| SQL role | Login account (`.env`) | Privileges on `university_timetable` |
|---|---|---|
| `tt_admin` | `MYSQL_ADMIN_USER` (default `tt_admin_app`) | `SELECT, INSERT, UPDATE, DELETE, EXECUTE` on every table, view and routine (no DDL) |
| `tt_faculty` | `MYSQL_FACULTY_USER` (default `tt_faculty_app`) | `SELECT` on the 11 timetable tables and the 4 views, granted table by table, **not** on `AppUser`; `EXECUTE` on the routines; no writes |
| *(service account)* | `MYSQL_USER` (`timetable`) | everything on the schema: `npm run` scripts, ETL, tests and the login lookup |

`pool("admin" | "faculty")` in `lib/server/db.ts` logs in with that account and runs `SET ROLE tt_admin` /
`SET ROLE tt_faculty` on every new connection, before anything else (instead of `SET DEFAULT ROLE`, whose syntax
differs between MySQL and MariaDB). Every API request uses the pool of the logged-in user's role. What the faculty account sees:

```text
SELECT CURRENT_ROLE()                -> `tt_faculty`@`%`
SELECT COUNT(*) FROM Timetable       -> 154
DELETE FROM Timetable WHERE ...      -> 1142 (42000): DELETE command denied to user 'tt_faculty_app'@'...' for table 'Timetable'
SELECT * FROM AppUser                -> 1142 (42000): SELECT command denied to user 'tt_faculty_app'@'...' for table 'AppUser'
```

The API turns such a database refusal into **403** with a plain-English message.

---

## How it works

### From the ER diagram to the relational schema

The supplied Chen ER diagram maps to tables with three standard rules:

- **1:N** relationship → a foreign key on the "many" side: `Faculty.dept_id`, `Course.dept_id`,
  `Section.dept_id`, `Student.section_id`.
- **M:N** relationship → a junction table with a composite primary key: `Teaches` (Faculty–Course) and
  `Enrollment` (Student–Course).
- **n-ary** relationship (`Scheduled_In`) → one table with a foreign key to each participant plus its own
  attribute: `Timetable(course, faculty, room, slot, section, academic_year)`.
- The application's login entity `AppUser` (added by `sql/06_auth_roles.sql`, not in the PDF) relates to
  `Faculty` through the 1:N relationship `Logs_In_As` → the nullable foreign key `AppUser.faculty_id`. Both sides
  participate partially: an admin login has no faculty row, and a teacher does not need a login.

```mermaid
flowchart TB
    %% Entities (rectangles)
    DEPT[Department]
    FAC[Faculty]
    CRS[Course]
    SEC[Section]
    STU[Student]
    ROOM[Classroom]
    SLOT[TimeSlot]
    USR["AppUser (sql/06)"]

    %% Relationships (diamonds)
    WORKS{Works_In}
    OFFERED{Offered_By}
    BELONGS{Belongs_To}
    STUDIES{Studies_In}
    TEACHES{Teaches}
    ENROLLED{Enrolled_In}
    TAKES{"Takes (M1)"}
    SCHED{Scheduled_In}
    LOGIN{Logs_In_As}

    %% Attributes (ovals), key attributes underlined
    d1(["<u>dept_id</u>"]) --- DEPT
    d2([dept_name]) --- DEPT
    d3([building]) --- DEPT

    f1(["<u>faculty_id</u>"]) --- FAC
    f2([name]) --- FAC
    f3([email]) --- FAC

    c1(["<u>course_id</u>"]) --- CRS
    c2([course_name]) --- CRS
    c3([credits]) --- CRS
    c4([weekly_hours]) --- CRS
    c5([course_type]) --- CRS

    s1(["<u>section_id</u>"]) --- SEC
    s2([section_name]) --- SEC
    s3([semester]) --- SEC
    s4([strength]) --- SEC

    st1(["<u>student_id</u>"]) --- STU
    st2([name]) --- STU
    st3([email]) --- STU

    r1(["<u>room_id</u>"]) --- ROOM
    r2([room_no]) --- ROOM
    r3([building]) --- ROOM
    r4([capacity]) --- ROOM
    r5([room_type]) --- ROOM

    t1(["<u>slot_id</u>"]) --- SLOT
    t2([day_of_week]) --- SLOT
    t3([period_no]) --- SLOT
    t4([start_time]) --- SLOT
    t5([end_time]) --- SLOT

    u1(["<u>user_id</u>"]) --- USR
    u2([username]) --- USR
    u3([password_hash]) --- USR
    u4([role]) --- USR
    u5([is_active]) --- USR
    u6([created_at]) --- USR
    u7([last_login]) --- USR

    %% Relationship attributes
    SCHED --- a1([academic_year])
    TAKES --- a2([semester])

    %% 1:N relationships (thick line = total participation)
    DEPT ---|1| WORKS
    WORKS ===|N| FAC
    DEPT ---|1| OFFERED
    OFFERED ===|N| CRS
    DEPT ---|1| BELONGS
    BELONGS ===|N| SEC
    SEC ---|1| STUDIES
    STUDIES ===|N| STU

    %% M:N relationships
    FAC ---|M| TEACHES
    TEACHES ---|N| CRS
    STU ---|M| ENROLLED
    ENROLLED ---|N| CRS
    SEC ---|M| TAKES
    TAKES ---|N| CRS

    %% 1:N, partial on both sides: an admin login has no Faculty row
    FAC ---|1| LOGIN
    LOGIN ---|N| USR

    %% 5-ary relationship (stored as the Timetable table)
    SCHED ---|N| CRS
    SCHED ---|N| FAC
    SCHED ---|N| ROOM
    SCHED ---|N| SLOT
    SCHED ---|N| SEC
```

*Chen notation: rectangles are entities, diamonds are relationships, ovals are attributes (key attributes underlined). Edge labels give the cardinality; a thick line means total participation (every Faculty, Course, Section and Student must belong to one). `Takes` is the `Section_Course` table added by migration M1; `Scheduled_In` is stored as the `Timetable` table; `AppUser` and `Logs_In_As` come from `sql/06_auth_roles.sql` (thin lines: partial participation on both sides).*

Rendered image: [`docs/er-diagram-chen.png`](docs/er-diagram-chen.png) (for slides, reports or viewers without Mermaid).

*(In the original drawing, Offered_By and Belongs_To appear to attach to Faculty; the relational schema
in the PDF uses `dept_id` on Course and Section, which is what this project follows.)*

**Hard constraints encoded in `Timetable`:** `UNIQUE(room, slot, year)`, `UNIQUE(faculty, slot, year)`,
`UNIQUE(section, slot, year)`: MySQL itself rejects any double booking.

### Improvements added on top of the PDF schema (`sql/02_migration_improvements.sql`)

`01_schema.sql` is the PDF DDL unchanged; every change lives in the migration and is flagged:

| # | Change | Why |
|---|---|---|
| M1 | New table `Section_Course(section_id, course_id, semester)` | The PDF has no record of which courses a section must take |
| M2 | FK `Timetable(faculty_id, course_id)` → `Teaches` | A faculty member can only be timetabled for a course they teach |
| M3 | FK `Timetable(section_id, course_id)` → `Section_Course` | A section can only get courses from its plan *(extra, easy to remove)* |
| M4 | Procedure `sp_validate_placement` | One place for the capacity and room-type rules |
| M5 | Triggers on `Timetable` (insert/update) and `Section_Course` | Room capacity ≥ section strength; LAB→LAB room, THEORY→LECTURE room; semester consistency. Errors 5001/5002/5003 |
| M6 | Indexes on `Timetable`, `Classroom`, `Course` | Speed for the common lookups |

**Views:** `v_section_timetable`, `v_faculty_timetable`, `v_room_utilization`, `v_free_slots`.
**Procedures:** `sp_faculty_workload(year)`, `sp_room_utilization(year)`, `sp_list_clashes(year)` (must return
**zero rows**), `sp_hours_coverage(year)` (zero rows = every section has exactly its weekly hours).

### Advanced SQL: function, CTE, recursive CTE

`sql/05_advanced_sql.sql` adds three objects (loaded automatically in Docker; they run on MySQL 8.0 and MariaDB):

| Object | Concept | What it returns | Used by |
|---|---|---|---|
| `fn_faculty_load(faculty_id, year)` | **Stored function** (`RETURNS INT READS SQL DATA`) | Periods per week of one teacher | the CTE below |
| `sp_department_summary(year)` | **Non-recursive CTEs** `WITH loads, ranked, staff, classes` + a **window function** (`ROW_NUMBER() OVER (PARTITION BY dept_id ...)`) | One row per department: faculty, teaching faculty, total and average load, busiest teacher, sections, classes | Statistics page |
| `sp_free_blocks(year, 'FACULTY' \| 'ROOM', id)` | **Recursive CTE** (`WITH RECURSIVE`) | Maximal runs of consecutive free periods per day | Timetable page (free blocks) |

`sp_free_blocks` treats two periods as consecutive when they are on the same day, `period_no` differs by one
and the gap is under 30 minutes (the same rule as the generator), so tea breaks keep a run going and lunch ends
it. The **anchor** member picks free slots with no free predecessor (a block starts there); the **recursive**
member extends a run by the next linked free slot; the final `SELECT` keeps runs whose last slot has no successor.

Output on the bundled data after `npm run generate` (identical on MySQL 8.0 and MariaDB 11.4):

```text
mysql> SELECT fn_faculty_load(1, '2026-2027') AS load_f1, fn_faculty_load(11, '2026-2027') AS load_f11;
+---------+----------+
| load_f1 | load_f11 |
+---------+----------+
|       8 |       10 |
+---------+----------+

mysql> CALL sp_department_summary('2026-2027');
+---------+-------------------------------------------+---------------+------------------+---------------+----------+-----------------------+--------------+----------+-------------------+
| dept_id | dept_name                                 | faculty_count | teaching_faculty | total_periods | avg_load | busiest_faculty       | busiest_load | sections | classes_scheduled |
+---------+-------------------------------------------+---------------+------------------+---------------+----------+-----------------------+--------------+----------+-------------------+
|       1 | Computer Science and Engineering          |            10 |               10 |            77 |     7.70 | Dr. Arvind Krishnan   |           11 |        5 |                77 |
|       2 | Electronics and Communication Engineering |             6 |                6 |            46 |     7.67 | Prof. Sangeetha Gopal |           11 |        3 |                46 |
|       3 | Mechanical Engineering                    |             4 |                4 |            31 |     7.75 | Dr. Mohan Rajan       |            9 |        2 |                31 |
+---------+-------------------------------------------+---------------+------------------+---------------+----------+-----------------------+--------------+----------+-------------------+

mysql> CALL sp_free_blocks('2026-2027', 'FACULTY', 1);     -- first rows of 15
+-------------+--------------+------------+------------+----------+--------+
| day_of_week | start_period | end_period | start_time | end_time | length |
+-------------+--------------+------------+------------+----------+--------+
| MON         |            1 |          4 | 08:30:00   | 12:05:00 |      4 |
| MON         |            6 |          7 | 13:50:00   | 15:45:00 |      2 |
| TUE         |            1 |          2 | 08:30:00   | 10:10:00 |      2 |
| TUE         |            4 |          4 | 11:15:00   | 12:05:00 |      1 |
| TUE         |            5 |          8 | 13:00:00   | 16:35:00 |      4 |
| ...         |              |            |            |          |        |
+-------------+--------------+------------+------------+----------+--------+
```

On Monday faculty 1 teaches only period 5, so the morning (P1–P4, across the tea break) is one block and P6–P7
another; P8 is busy. Lunch splits P4 and P5 into separate blocks on Tuesday.

### The scheduler (`lib/server/generator.ts`)

1. **Load** slots, sections, plans, teachers, rooms and the course *conflict graph* (courses sharing
   qualified faculty or enrolled students).
2. **Pre-flight**: cheap necessary-condition checks that explain impossible inputs immediately (a course nobody
   teaches, no room big enough, too many hours for the available teachers or slots ...).
3. **Split into tasks**: each theory period is a task; each lab becomes blocks of up to 3 consecutive periods.
4. **Order by difficulty**: labs first, then fewer qualified teachers, fewer eligible rooms, higher
   conflict-graph weight, more hours (the graph-colouring "most constrained first" idea).
5. **Search with backtracking**: for each task, enumerate every placement that satisfies all hard
   constraints, sorted by soft-constraint penalty; place the best, and undo and try the next if a later task
   gets stuck. A node/time budget with randomised restarts stops unlucky early choices from trapping the search.
6. **Failure handling**: if no complete timetable is found, a no-backtracking pass places what it can and
   explains every class it cannot ("31 of 48 slots already used by the section, 12 have every qualified teacher busy ...").
7. **Save** in one transaction; MySQL errors (`1062` unique clash, `1452` foreign key, `5001-5003` triggers)
   are translated into plain English and roll everything back.

*Hard:* no room / teacher / section double-booked; room type and capacity fit; teacher in `Teaches`; exactly
`weekly_hours` per course per section. *Soft (best effort):* spread a course across days, never the same course
twice in a day, at most 3 consecutive periods per teacher, lab periods consecutive (never across lunch).

### The graph layer (Neo4j)

`lib/server/etl.ts` (`npm run etl`, or the web app's **Update Neo4j graph** button) copies MySQL into Neo4j with `MERGE` (safe to repeat): constraints and indexes first, then
nodes, relationships, the timetable, and finally the derived `CONFLICTS_WITH`. Relationships whose MySQL row was
deleted (for example a `Teaches` row removed by an undo) are pruned, so the graph never keeps ghosts.

| Nodes | Relationships |
|---|---|
| Department, Faculty, Course, Section, Student, Classroom, TimeSlot | `WORKS_IN`, `TEACHES`, `STUDIES_IN`, `ENROLLED_IN`, `OFFERED_BY`, `SCHEDULED_IN` (Course→Section, one per timetable row, carrying room, slot, teacher, year), `CONFLICTS_WITH` (Course–Course, `shared_faculty`, `shared_students`, `shared_count`); extras `BELONGS_TO`, `TAKES`, `TEACHES_SECTION`; app-owned `UNAVAILABLE_AT` (Faculty→TimeSlot, `reason`, `updated_at`) |

The queries live in `cypher/queries.cypher` (fully commented; `lib/server/neo4j.ts` parses it at run time and runs exactly those statements). The 12
analytic ones:

| Query | Answers |
|---|---|
| `impact_analysis` | Which classes (and how many students) are lost if a teacher is absent? |
| `substitute_finder` | Same-department colleagues free in each affected slot, qualified or related |
| `most_conflicted_courses` | Which courses collide with the most others? |
| `free_rooms` | Free rooms in a slot by minimum capacity and type |
| `heaviest_day_students` | Students whose busiest day has the most periods |
| `faculty_shortest_path` | Shortest chain between two teachers via shared courses or sections |
| `faculty_workload` | Teachers ranked by weekly periods |
| `move_class_ripple` | What collides if one class moves to another slot? |
| `cross_department_teaching` | Teachers qualified for another department's courses |
| `course_conflict_neighbours` | The collision neighbourhood of one course |
| `node_counts`, `relationship_counts` | Graph size (used to verify the ETL) |

and five for the Graph page (next section): `node_browser`, `node_neighbours`, `faculty_unavailability` (read),
`set_unavailability` (create/update), `delete_unavailability` (delete).

### Neo4j read, update, delete: the Graph page

The graph is mostly a read-only copy of MySQL, but one kind of data lives **only** in Neo4j: *faculty
unavailability marks*, `(Faculty)-[:UNAVAILABLE_AT {reason, updated_at}]->(TimeSlot)`, e.g. "Dr. X is at a
conference on Friday period 3". The **Graph (Neo4j)** page of the web app works on them through the API:

| Operation | Web app | API route | Cypher (`cypher/queries.cypher`) |
|---|---|---|---|
| **Read** nodes | Node browser: pick a label, search by id or name; shows properties and degree | `GET /api/graph/nodes` | `node_browser` |
| **Read** relationships | Click a node: its neighbours, relationship type and direction | `GET /api/graph/neighbours` | `node_neighbours` |
| **Read** marks | Faculty unavailability list (everyone may read) | `GET /api/graph/unavailability` | `faculty_unavailability` |
| **Create / Update** | Slot + reason → *Save*; *Edit reason* on a row (admin) | `PUT /api/graph/unavailability` | `set_unavailability` (`MERGE` + `SET u.reason, u.updated_at = datetime()`) |
| **Delete** | *Delete* on a row (admin) | `DELETE /api/graph/unavailability` | `delete_unavailability` |

The marks matter: `substitute_finder` skips a candidate who is marked unavailable in the slot to cover
(`AND NOT EXISTS { (cand)-[:UNAVAILABLE_AT]->(:TimeSlot {slot_id: s.slot_id}) }`), so the **Faculty absent**
page never suggests them. Input is validated in `lib/server/neo4j.ts` (label whitelist, integer ids, reason at most
200 characters); unknown faculty or slot gives 404, Neo4j being down gives 503.

**Lifetime:** a normal `npm run etl` run keeps the marks (the ETL only prunes relationship types it
builds from MySQL). `npm run etl -- --reset` wipes the whole graph, **marks included**.

### Why MySQL **and** Neo4j?

- **MySQL** is the right home for the timetable itself: strict schemas, foreign keys, unique constraints,
  triggers and transactions guarantee that no invalid timetable can ever be stored. Weekly grids, totals and
  utilisation are classic set-based SQL.
- **Neo4j** is the right tool for *connected* questions: "who can cover for X?", "how are these two
  teachers linked?", "what else breaks if I move this class?" are multi-hop traversals that need several
  self-joins in SQL but a single readable pattern in Cypher.
- Keeping MySQL as the single source of truth and treating Neo4j as a rebuildable copy avoids
  consistency problems: if the graph is ever stale or damaged, `npm run etl -- --reset` rebuilds it
  (only the unavailability marks, which exist only in Neo4j, are lost).

### Why one Next.js + TypeScript application?

- **One language, one process.** The pages, the JSON API, the scheduler, the ETL, the Neo4j queries and the
  command-line tools are all TypeScript in one Next.js project. `npm ci` installs everything; `npm run dev` starts
  everything. There is no second runtime (and no virtual environment) to install, and no second server to keep
  running and configure (`API_URL`, ports, proxying).
- **Shared types end to end.** The response shapes in `lib/types.ts` are used by the pages and checked by the
  compiler (`npm run lint` = `tsc --noEmit` in strict mode) together with the route handlers and the server code,
  so a renamed field breaks the build instead of a page.
- **Route handlers are the API.** Each endpoint is a small file under `app/api/` that authenticates the user,
  opens a MySQL connection on the matching role account and calls the shared code in `lib/server/`. Pages and API
  share one origin, so the session cookie is `httpOnly` and first-party without any CORS setup; the browser never
  holds database credentials, and the same API can serve another client (a mobile app, scripts) later.
- **Same code from the command line.** `npm run generate`, `etl` and `queries` run the same `lib/server/` modules
  as the web app (through `tsx`, no build step), and the Vitest suite tests the route handlers directly with real
  `Request` objects.
- **Mature drivers:** `mysql2` (connection pools, prepared statements) and the official `neo4j-driver`.
- Everything is mainstream, well documented and free; no UI kit or chart library is used, the CSS is one file.

### Sample data (`sql/03_seed_data.sql`)

3 departments (CSE, ECE, Mechanical) · 20 faculty · 30 courses (24 theory, 6 lab; labs are 2 periods) ·
10 sections in odd semesters 3 and 5 · 120 students (12 per section; `Section.strength` of 45–60 is the declared
class size used for capacity checks) · 25 rooms (18 lecture, 7 lab) · 48 slots (Mon–Sat × 8 periods, lunch
between periods 4 and 5) · 62 `Teaches`, 50 `Section_Course`, 600 `Enrollment` rows. Two teachers are qualified
across departments so the graph has bridges. Every section needs 15–16 of 48 slots and every course has at least
two qualified teachers, so a clash-free timetable always exists.
`npm run make-seed` (`scripts/make-seed.ts`) regenerates the file deterministically.

---

## Configuration reference

Set in `.env` (see `.env.example`); the Next.js server, the `npm run` scripts and the tests all read it.
Real environment variables take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `MYSQL_HOST` | `127.0.0.1` | Database host |
| `MYSQL_PORT` | `3306` | `3306` for a local server, `3307` for the Docker container |
| `MYSQL_USER` | *(required)* | Application user (`timetable`), **not** root |
| `MYSQL_PASSWORD` | *(empty)* | Its password |
| `MYSQL_DATABASE` | `university_timetable` | Database name |
| `MYSQL_UNIX_SOCKET` | *(unset)* | Connect through a socket instead of TCP (local Linux/macOS) |
| `NEO4J_URI` | `bolt://localhost:7687` | Bolt address |
| `NEO4J_USER` | `neo4j` | Neo4j user |
| `NEO4J_PASSWORD` | *(required)* | Must equal the password Neo4j was set up with (8+ chars) |
| `NEO4J_DATABASE` | `neo4j` | Community Edition has only this database |
| `MYSQL_ADMIN_USER`, `MYSQL_ADMIN_PASSWORD` | `tt_admin_app`, *(required for the web app)* | Login account holding the SQL role `tt_admin` (admin requests) |
| `MYSQL_FACULTY_USER`, `MYSQL_FACULTY_PASSWORD` | `tt_faculty_app`, *(required for the web app)* | Login account holding the SQL role `tt_faculty` (faculty requests) |
| `APP_SECRET` | *(required for the web app)* | Signs the session cookie; a long random string. Without it nobody can log in; changing it logs everybody out |
| `ACADEMIC_YEAR` | `2026-2027` | Year used by default everywhere |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_HOST_PORT` | *(Docker only)* | Container root password; published host port (default 3307) |

With Docker, the `MYSQL_ADMIN_*` / `MYSQL_FACULTY_*` values are also used once, when the container creates the
role accounts on a fresh volume: change them before the first `docker compose up`, or run `docker compose down -v`.

---

## Verify your installation

Work through this list; each line says what you should see. (Commands for the database checks use `sudo mysql`;
substitute your own admin command, or use the `timetable` user.)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Schema loaded | `mysql ... -e "SHOW FULL TABLES" university_timetable` | 12 base tables (11 + `AppUser`) + 4 views |
| 2 | Seed loaded | `SELECT COUNT(*) FROM Faculty; SELECT COUNT(*) FROM Student; SELECT COUNT(*) FROM Enrollment;` | 20 · 120 · 600 |
| 3 | Rules installed | `SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='university_timetable';` | 4 |
| 3b | Routines and logins | `SELECT routine_type, COUNT(*) FROM information_schema.routines WHERE routine_schema='university_timetable' GROUP BY routine_type; SELECT username, role FROM AppUser;` | 1 FUNCTION, 7 PROCEDURE · `admin`, `faculty1`, `faculty2` |
| 3c | SQL roles | `SHOW GRANTS FOR tt_faculty;` | `SELECT` on 11 tables + 4 views (no `AppUser`), `EXECUTE`; nothing else |
| 4 | Generator dry run | `npm run generate -- --dry-run` | `Result: COMPLETE`, `Periods placed: 154 / 154` |
| 5 | Generator saves | `npm run generate -- --replace` | `Saved to MySQL: yes (154 rows)` |
| 6 | No clashes | `CALL sp_list_clashes('2026-2027');` | **empty result** |
| 7 | Hours correct | `CALL sp_hours_coverage('2026-2027');` | **empty result** |
| 7b | Advanced SQL | `CALL sp_department_summary('2026-2027'); CALL sp_free_blocks('2026-2027','FACULTY',1);` | 3 rows (77 / 46 / 31 periods) · 15 rows, first `MON 1-4` (see [Advanced SQL](#advanced-sql-function-cte-recursive-cte)) |
| 8 | Neo4j login | `npm run queries -- check` | `Connection: OK` |
| 9 | ETL | `npm run etl` | `Verification: OK, graph matches MySQL`; running it twice gives identical counts |
| 10 | Graph size | `npm run queries -- demo` (first tables) | nodes 3/20/30/10/120/25/48; `SCHEDULED_IN` 154, `CONFLICTS_WITH` 91, `TEACHES_SECTION` 80, `TEACHES` 62, `ENROLLED_IN` 600 |
| 11 | API | `npm run dev`, then open <http://localhost:3000/api/health> | `{"mysql":true,"neo4j":true}` |
| 12 | Web app | with `npm run dev` running, open <http://localhost:3000>, log in as `admin` / `admin123` | Timetable grid for "Computer Science and Engineering / Sem 3 / A" shows 15 periods; sidebar shows MySQL and Neo4j connected |
| 13 | Constraints bite | In the app: *Clash checker → Check a proposed class*, choose a THEORY course with a LAB room | "MySQL would REJECT this class" |
| 14 | Roles bite | Log out, log in as `faculty1` / `faculty123` | Own timetable is shown; *Run generator* is not in the menu; no Assign buttons or unavailability form. `curl` to an admin route with that cookie → 403 |
| 15 | Neo4j RUD | As admin: *Graph (Neo4j)* → mark a teacher unavailable in a slot they are free in; *Faculty absent* for a colleague teaching then | The marked teacher is no longer offered as a substitute for that slot; delete the mark and they are back |
| 16 | Test suite | `npm test` | see [Tests](#tests) for the expected summary line |
| 17 | Type check and build | `npm run lint && npm run build` | no errors; the build lists the pages and the `/api/*` routes |

---

## Troubleshooting

<details><summary><b>MySQL / MariaDB</b></summary>

| Symptom | Cause and fix |
|---|---|
| `mysql: Deprecated program name ... use mariadb` | Your `mysql` is MariaDB's client; harmless. Use `mariadb` / `sudo mariadb` |
| `ERROR 1698 Access denied for user 'root'@'localhost'` | Root uses socket authentication (Linux/MariaDB/Ubuntu): run the client with `sudo`, and create the `timetable` user for the application |
| The app or an `npm run` script says `Access denied` for `timetable` | Wrong `MYSQL_PASSWORD` in `.env`, or the user was not created for both `'localhost'` and `'127.0.0.1'`; or set `MYSQL_UNIX_SOCKET` |
| `Could not use MySQL: 2003 ... Connection refused` | The database server is not running, or `MYSQL_HOST` / `MYSQL_PORT` are wrong (3306 local, 3307 Docker). Start the server and retry |
| `Could not use MySQL: 1045 Access denied` | Wrong `MYSQL_USER` / `MYSQL_PASSWORD` in `.env`, or the user was not created (step B2) |
| `MYSQL_USER is not set` | `.env` missing or in the wrong folder. It must be in the project root, next to `package.json`; run the `npm` commands from there |
| Errors around `DELIMITER` when loading `02` / `04` | Load with the command-line client (`-e "source ..."`), not Workbench or a database driver |
| `01_schema.sql` fails: database exists / `02` fails: already exists | Files are one-shot. `DROP DATABASE university_timetable;` and start again |
| Cannot delete a `Teaches` row | Intended: the composite foreign key protects timetable rows that use it. Clear `Timetable` first or re-run `03_seed_data.sql` |
| Port 3306 already in use with Docker | Keep the default `MYSQL_HOST_PORT=3307` and `MYSQL_PORT=3307` in `.env` |
| Windows PowerShell rejects `< file.sql` | Use `mysql -u root -p -e "source sql/01_schema.sql"` |
</details>

<details><summary><b>Neo4j</b></summary>

| Symptom | Cause and fix |
|---|---|
| `ServiceUnavailable` / connection refused on 7687 | Neo4j is not running. Start it (`bin/neo4j console`, or `docker compose up -d`). The web app's sidebar shows "Neo4j: unavailable"; Neo4j routes return 503 |
| `AuthError` / unauthorized | `NEO4J_PASSWORD` in `.env` is not the password Neo4j has. Run `npm run queries -- check` (shows where the value comes from and whether a real environment variable overrides `.env`). A fresh Neo4j starts with user/password `neo4j`/`neo4j` and forces a change on first browser login |
| Need to reset the password (nothing stored yet) | Stop Neo4j (`bin/neo4j stop`, check with `status`), `rm -rf data/databases data/transactions`, `bin/neo4j-admin dbms set-initial-password <new>`, start again. `set-initial-password` only works **while Neo4j is stopped and before its first start** |
| Neo4j does not start | `java -version` must report 17 or 21; check that ports 7474/7687 are free |
| "graph is out of date" in the app | You regenerated the timetable. Click **Update Neo4j graph** or run `npm run etl` |
| ETL says `MISMATCH` | Re-run with `--reset` (this also deletes the unavailability marks); if it persists, compare the listed counts with MySQL |
| Unavailability marks disappeared | `--reset` or `docker compose down -v` wipes them; a normal ETL run keeps them |
</details>

<details><summary><b>Node.js, npm and the generator</b></summary>

| Symptom | Cause and fix |
|---|---|
| `npm ci` fails, `tsx: not found` / `next: not found` | Use Node 22 (`node -v`) and run the commands in the project root (next to `package.json`); then `npm ci` again |
| `npm ci` complains that `package.json` and `package-lock.json` are out of sync | Somebody edited `package.json` by hand: run `npm install` once and commit the updated lock file |
| A flag is ignored, or npm prints `Unknown cli config` | Script options go after `--`: `npm run generate -- --replace`, not `npm run generate --replace` |
| Environment variables do not stick / different syntax in bash vs fish vs PowerShell | Put everything in `.env`; every script reads it in every shell |
| `154 rows already exist for 2026-2027; ... --replace to overwrite` | Intended safety. Use `--replace` to overwrite |
| Generator: `PARTIAL` / `FAILED` with reasons | Read the "Could NOT be placed" lines (e.g. every qualified teacher busy, no free room of that type). Fix the data, or add `--allow-partial` to keep a partial result |
| Generator: "input data makes a timetable impossible" | Pre-flight found a necessary condition that fails (course with no teacher, no big enough room ...). The message names the course |
</details>

<details><summary><b>Web app and API</b></summary>

| Symptom | Cause and fix |
|---|---|
| Login answers "Internal Server Error" and the `npm run dev` terminal shows `APP_SECRET is not set` | Put a long random `APP_SECRET` in `.env` (see [Configuration reference](#configuration-reference)) and restart `npm run dev` |
| Login works but every page says it cannot reach MySQL, or the API answers 503 / "Access denied for user 'tt_..._app'" | The role accounts do not exist or their passwords differ from `.env`. Docker: the accounts are created only on a fresh volume, so `docker compose down -v && docker compose up -d --wait` (then rerun the generator and ETL). Native: step B3b |
| `Table 'university_timetable.AppUser' doesn't exist` / `FUNCTION fn_faculty_load does not exist` | `sql/05` and `sql/06` are not loaded: with Docker recreate the volume as above, natively run them (step B3) |
| Changes to `.env` have no effect | The Next.js server reads `.env` when it starts: stop `npm run dev` (Ctrl+C) and start it again |
| Always redirected back to `/login` | The session expired (8 h) or `APP_SECRET` changed: log in again |
| "Only an admin can do this." (403) | You are logged in as a faculty user; log in as `admin` |
| `npm run build` fails with type errors | Run `npm run lint` to see them all; the build type-checks the whole project |
| Port 3000 already in use | `npm run dev -- --port 3001` (or `npm run start -- --port 3001`) |
</details>

---

## Tests

One test runner, [Vitest](https://vitest.dev/), with two projects (see `vitest.config.mts`):

```bash
npm test                                         # everything: ui + server (needs MySQL + .env; Neo4j optional)
npx vitest run --project ui                      # only the page and component tests (no servers needed)
npx vitest run --project server                  # only the database / API / graph tests
npx vitest run tests/server/api.test.ts tests/server/roles.test.ts   # only the API and the SQL roles
npx vitest                                       # watch mode while you work
npm run lint                                     # TypeScript type check (same check as CI)
npm run build                                    # production build
```

- **`ui`** (`tests/ui/`, jsdom): React Testing Library tests that mock `fetch`, so no server is needed.
- **`server`** (`tests/server/`, Node): run against the real MySQL from `.env` (and Neo4j when it is up). The files
  run one after another (they share the database), and the setup loads `.env` and closes the connection pools.
  The API tests call the route handlers in `app/api/` directly with real `Request` objects, so no web server
  is started either.

**Safety:** the tests never change your real timetable. Anything that writes uses a throw-away academic year
(`2099-2100`, wiped before and after) or a transaction that is rolled back. Logins restore `AppUser.last_login`
afterwards. The Neo4j tests only read, except the unavailability tests, which create their own mark and delete it.

| File (`tests/server/`) | What it proves |
|---|---|
| `schema.test.ts` | Object counts and seed sizes; `CHECK` constraints (including "a faculty login must link to a Faculty row"); a room, teacher or section **cannot be double-booked** (errors named by constraint), but the same slot is free in another year; the **triggers** reject a too-small room and a wrong room type (5001/5002) and a wrong semester (5003); a teacher must be in `Teaches` and a course in the section's plan (composite FKs); a `Teaches` row in use cannot be deleted; `sp_list_clashes` catches drift the triggers cannot see |
| `advanced-sql.test.ts` | `fn_faculty_load` equals a plain count; `sp_department_summary` totals match the timetable; `sp_free_blocks` returns exactly the free periods of every teacher and room as maximal, lunch-aware runs; an empty year gives the half days; an unknown kind is rejected |
| `generator.test.ts` | A complete timetable is found; an **independent checker** (written from the raw tables, not from generator internals) confirms every hard rule and the exact weekly hours; soft constraints met on the seed data; labs consecutive and never across lunch; same seed ⇒ same result; saved timetable passes `sp_list_clashes` and `sp_hours_coverage` with zero rows; refuses to overwrite; a bad row **rolls back the whole save**; the proposed-class check rule by rule; impossible input is explained, not crashed on; when the search runs out of budget the partial result is still clash-free, every unplaced class has a reason, and nothing is saved; CLI exit codes (0 / 2 when MySQL is unreachable) |
| `substitutes.test.ts` | Assigning a qualified substitute keeps the timetable clash-free and can be undone; a busy teacher is refused; an unqualified one needs the `Teaches` row, which undo removes again; an undo that cannot drop that row (now used by another class) changes nothing; bad requests are explained. Uses the throw-away year and restores `Teaches` |
| `etl-offline.test.ts` | Without Neo4j: constraints are created first, nodes before relationships, the old timetable is deleted before reload, rows sent equal the MySQL counts, every static relationship type is pruned against MySQL, the ETL never deletes unavailability marks, batches never exceed 500; `--year` verification covers every year in the graph; a friendly exit code 2 when Neo4j is unreachable |
| `neo4j-live.test.ts` | With Neo4j: every node/relationship count equals MySQL; `CONFLICTS_WITH` built in Neo4j **equals** the SQL definition; workload totals, absence plans, free rooms, shortest paths and the move-ripple agree with MySQL; node browser and neighbours; an unavailability mark can be created, updated and deleted, and the substitute finder skips a colleague marked unavailable |
| `neo4j-queries.test.ts` | Every documented query loads from `cypher/queries.cypher` and each wrapper passes exactly the parameters its query uses; the graph write wrappers validate their input; absence-plan and ranking logic; `.env` parsing, the masked settings report, the driver cache |
| `auth.test.ts` | PBKDF2 hash and verify, a salt per hash, malformed hashes never verify, the seeded demo users have the documented passwords; session tokens round-trip, and tampered or expired tokens are rejected |
| `roles.test.ts` | Each role account runs with its SQL role and has **no** privileges before `SET ROLE`; the faculty role can read the timetable but every `INSERT` / `UPDATE` / `DELETE` and any read of `AppUser` is denied (1142); the admin role can write but has no DDL |
| `api.test.ts` | Every route handler: login sets an httpOnly cookie, wrong password 401, a malformed body 422, every route needs a login, expired session 401, logout, unknown paths a JSON 404; faculty gets **403** on every admin route; the shapes of meta, timetable, free blocks, clashes, proposed-class check, stats; generator dry run changes nothing; substitute assign + undo; graph browser, absence and ripple; unavailability create/update/delete; Neo4j down gives 503 |
| `validation.test.ts` | Request validation coerces and rejects query and body values (whole numbers, booleans, ranges) and reports problems as 422 errors with a `detail` list |
| `refresh-graph.test.ts` | After a substitution the graph refresh reports a plain-English problem when Neo4j is down or out of sync, without undoing the MySQL change |
| `db.test.ts`, `utils.test.ts` | Connection pools, `SET ROLE`, value conversions, transactions commit/roll back, stored-procedure calls, a missing `MYSQL_USER` is reported; times, lunch-aware slot links, the weekly grid, error wording, table formatting |
| `seed.test.ts` | `sql/03_seed_data.sql` is byte-identical to what `scripts/make-seed.ts` generates |
| `project-files.test.ts` | Required files exist and no Python is left; every setting the code reads is in `.env.example`; `.env`, `node_modules/` and `.next/` are git-ignored; `package.json` has the documented scripts; every SQL file is loaded by Docker and by CI; the README's options, `npm run` scripts, links and file names are real |

**Expected result on the bundled data** (207 tests in 25 files: 28 `ui` + 179 `server`):

| Situation | Summary lines |
|---|---|
| MySQL only (no Neo4j) | `Test Files 24 passed \| 1 skipped (25)` · `Tests 194 passed \| 13 skipped (207)` |
| + Neo4j running with the graph loaded (`npm run etl`) | `Test Files 25 passed (25)` · `Tests 207 passed (207)` |

The 13 skips are the live-Neo4j tests (10 in `neo4j-live.test.ts`, 3 in `api.test.ts`); the run prints why
("Neo4j not reachable ..." or "The Neo4j graph is empty. Run `npm run etl` first."). Skipped is not failed, but it also means
**not checked**: run the Neo4j tests at least once.

**UI tests** (`tests/ui/`, 28 tests in 9 files): the `WeekGrid` (break rows, lab colour, lines), CSV quoting,
`BarChart`, `DataTable`, the API client (JSON errors, redirect to `/login` on 401), the login page (submits, shows
the error on a 401), the sidebar hiding admin links for faculty, the timetable page and the absent page (Assign
disabled until the `Teaches` box is ticked).

*Do the tests really catch mistakes?* The database checks were verified by sabotage: dropping the `fk_tt_teaches`
foreign key, the capacity trigger, the unique key on teachers, or changing the seed data each made the matching
tests fail. (That was done on the earlier Python suite; the TypeScript tests port those checks one to one.)

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main` (Node 22 with the npm cache):

| Job | What it does |
|---|---|
| `lint` | `npm ci`, `npm run lint` (type check), `actionlint` on the workflow, `docker compose config`, and `bash -n` on the shell scripts |
| `test-docker-compose` | Starts MySQL 8.0 + Neo4j 5.26 with `docker compose up -d --wait` (the Docker path above, `.env` copied from `.env.example`), then `npm ci`, `npm run generate -- --replace`, `npm run etl`, `npm run queries -- demo`, the **whole** suite (`npm test`) and `npm run build` |
| `test-mariadb` | Loads `sql/01` → `06` into MariaDB 11.4 with its own client, creates the service account and the two role accounts as `docker/mysql/07_role_accounts.sh` does, then `npm ci`, `npm run generate -- --replace` and `npm test` (no Neo4j, so the 13 Neo4j tests skip) |

## Status and limitations

| Part | Status |
|---|---|
| Schema, migration, views, procedures, seed data | Done; verified on MySQL 8.0 and MariaDB |
| Scheduler | Done; verified on MySQL 8.0 and MariaDB |
| Neo4j ETL and queries, graph RUD | Done; verified on Neo4j 5.26.0 |
| Advanced SQL (function, CTE, recursive CTE) | Done; verified on MySQL 8.0 and MariaDB 11.4 |
| Login, roles, SQL-level RBAC | Done; verified on MySQL 8.0 and MariaDB 11.4 |
| Web app and API (Next.js) | Done; replaces the earlier Streamlit app feature for feature; API covered by `tests/server/api.test.ts`, pages and components by `tests/ui/` |
| TypeScript port | Done: the former Python backend (FastAPI, scheduler, ETL, CLI tools, pytest suite) was ported to TypeScript with the same API contract, messages and behaviour; no Python remains |
| Docker Compose | Done; verified (MySQL 8.0 + Neo4j 5.26) and exercised by CI |
| Substitute assignment | Done; tested against MySQL 8.0 and MariaDB |
| Automated test suite | Done: 207 Vitest tests (all pass with MySQL 8.0 + Neo4j 5.26; 194 pass and 13 skip with MySQL or MariaDB 11.4 alone) |
| Continuous integration | GitHub Actions, Node only: lint (type check, actionlint, compose, shell), tests + build on MySQL 8/Neo4j 5 (docker compose), tests on MariaDB 11.4 |

Known limitations (by design, for a mini-project):

- Triggers fire on `Timetable` writes only: lowering a room's capacity *after* scheduling is not blocked, but
  `sp_list_clashes` reports it.
- A class has one teacher and one room; no split batches or team teaching. A lab uses a lab room big enough for the
  whole section.
- Students take their section's plan (`Section_Course`); individual electives/backlogs are not modelled, so
  student-level clashes cannot occur by construction.
- The generator is a heuristic: it finds a feasible timetable fast on the seed data, but very tight inputs
  can exceed the time budget (it then reports a partial result with reasons).
- The Neo4j graph is a copy: refresh it after regenerating the timetable (the web app does this itself after a
  substitute assignment).
- Assigning a substitute changes the **weekly** timetable. A one-day cover (this Monday only) is not modelled;
  it would need a dated substitutions table.
- The session cookie is not marked `Secure` so that it works on `http://localhost`. To expose the app beyond your
  machine, put it behind HTTPS, set the cookie to `Secure`, replace the demo passwords, `APP_SECRET` and the
  database passwords, and do not publish the database ports.
- There is no user-management page: add or deactivate logins with SQL (`INSERT INTO AppUser ...` with a hash from
  `npm run hash-password`, or `UPDATE AppUser SET is_active = FALSE ...`). There is no login rate limiting.
- Unavailability marks live only in Neo4j (no MySQL copy), so `--reset` or a fresh Neo4j volume loses them.

## Working in a team

- Copy `.env.example` to `.env` and use your own passwords. **Never commit `.env`** (it is git-ignored).
- Run `npm run lint && npm test` (and `npm run build` for page changes) before you commit; add a test with every
  rule you add. CI runs all of them on every pull request.
- Change the database through **new migration files** (`sql/08_...sql`), not by editing the applied ones. Mount a new
  file in `docker-compose.yml` and load it in the CI MariaDB job (`tests/server/project-files.test.ts` checks both).
- The API contract is the route handlers in `app/api/` plus the response types in `lib/types.ts` that the pages
  use; change both together (`tests/server/api.test.ts` checks the response shapes).
- Teammates can use different servers (MySQL vs MariaDB): everything uses standard SQL and the portable
  `source` loading command.
- `CONTEXT.md` records decisions, the verified state and environment quirks; update it when you change
  something significant.

## License

No license has been chosen yet. Add a `LICENSE` file (for example MIT) before publishing the repository.