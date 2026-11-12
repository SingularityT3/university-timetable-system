"""
main.py -- FastAPI backend for the web app (web/, Next.js).

Run from the project root:   uvicorn api.main:app --port 8000
Interactive docs:            http://127.0.0.1:8000/docs

It reuses src/ (generator, Neo4j ETL and queries) and adds login + roles:
  * POST /auth/login checks AppUser (PBKDF2 hash) and sets the signed httpOnly cookie `tt_session`.
  * Every other route needs that cookie; routes marked "admin only" return 403 for faculty.
  * Each request talks to MySQL on the account of the user's role (db.connection(role=...)),
    which activates the SQL role tt_admin or tt_faculty. A faculty request therefore cannot
    write to MySQL at all, whatever the code does: the database refuses it.
MySQL errors become 400/403/409 with a plain-English message; Neo4j being down becomes 503.
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from datetime import date, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, FastAPI, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import mysql.connector  # noqa: E402

import db  # noqa: E402
import generator  # noqa: E402
import neo4j_etl  # noqa: E402
import neo4j_queries  # noqa: E402
import utils  # noqa: E402
from api import auth  # noqa: E402

SECRET = auth.app_secret()          # refuse to start without APP_SECRET
DAYS = utils.DAY_ORDER
Year = Annotated[str | None, Query(max_length=9, description="academic year; default ACADEMIC_YEAR")]
EntityId = Annotated[int, Query(alias="id")]


# ================================================================ helpers
def clean(value):
    """JSON-friendly copy: TIME -> 'HH:MM', Decimal -> float, dates and Neo4j times -> ISO text."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (timedelta, time)):
        return utils.fmt_time(value)
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    if hasattr(value, "iso_format"):                  # neo4j.time.DateTime
        return value.iso_format()
    return value


def year_or_default(year: str | None) -> str:
    return year or utils.academic_year()


def neo4j_status() -> tuple[bool, str]:
    try:
        neo4j_queries.get_driver()
        return True, "connected"
    except Exception as exc:                          # noqa: BLE001 -- any reason is shown in the UI
        return False, type(exc).__name__


def neo4j_call(fn, *args, **kwargs):
    """Run a Neo4j function; unreachable -> 503, bad input -> 400, not found -> 404."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:
        name = type(exc).__name__
        if name in ("ServiceUnavailable", "AuthError", "SessionExpired") or (
                name == "RuntimeError" and "NEO4J" in str(exc)):
            raise HTTPException(503, f"Neo4j is not reachable ({name}). Start it (docker compose up -d), "
                                     "check `python src/neo4j_queries.py check`, then try again.") from exc
        if isinstance(exc, (ValueError, TypeError)):
            raise HTTPException(400, str(exc)) from exc
        if isinstance(exc, LookupError):
            raise HTTPException(404, str(exc)) from exc
        raise


def graph_stale_message(conn, year: str) -> str | None:
    """
    Compare the Neo4j graph with MySQL for `year` (classes per faculty member, so a
    reassigned class is noticed too). None when equal or when Neo4j is unreachable.
    """
    try:
        rows = neo4j_queries.faculty_workload_ranking(year)
    except Exception:                                 # noqa: BLE001 -- the plan call reports Neo4j errors
        return None
    in_graph = {r["faculty_id"]: r["periods"] for r in rows if r["periods"]}
    in_mysql = {r["faculty_id"]: r["n"] for r in db.query(
        conn, "SELECT faculty_id, COUNT(*) AS n FROM Timetable WHERE academic_year = %s GROUP BY faculty_id",
        (year,))}
    if in_graph == in_mysql:
        return None
    differ = len(set(in_graph.items()) ^ set(in_mysql.items()))
    return (f"The Neo4j graph differs from MySQL for {year} (graph: {sum(in_graph.values())} classes, "
            f"MySQL: {sum(in_mysql.values())}; {differ} per-faculty count(s) differ). "
            "Results below may be out of date.")


def refresh_graph(year: str) -> str | None:
    """Re-run the ETL for `year` after a MySQL change; returns a problem text or None."""
    try:
        result = neo4j_etl.run_etl(year, log=lambda *_: None, role="admin")
    except Exception as exc:                          # noqa: BLE001 -- MySQL is already updated
        return f"MySQL is updated, but refreshing Neo4j failed ({type(exc).__name__}: {exc})."
    return None if result["ok"] else "Neo4j graph does not match MySQL: " + "; ".join(result["problems"])


def count_classes(conn, year: str) -> int:
    return db.query(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s", (year,))[0]["n"]


# =========================================================== dependencies
def current_user(tt_session: Annotated[str | None, Cookie()] = None) -> dict:
    """The logged-in AppUser (401 when the cookie is missing, invalid, expired or the user inactive)."""
    payload = auth.read_token(tt_session, SECRET)
    user = auth.get_user(payload["uid"]) if payload else None
    if user is None:
        raise HTTPException(401, "Not logged in, or the session has expired.")
    return user


def require_admin(user: Annotated[dict, Depends(current_user)]) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Only an admin can do this.")
    return user


def db_conn(user: Annotated[dict, Depends(current_user)]):
    """MySQL connection on the account of the user's role (SQL role tt_admin / tt_faculty)."""
    with db.connection(role=user["role"]) as conn:
        yield conn


def admin_conn(_user: Annotated[dict, Depends(require_admin)]):
    with db.connection(role="admin") as conn:
        yield conn


DbConn = Annotated[object, Depends(db_conn)]
AdminConn = Annotated[object, Depends(admin_conn)]


# ===================================================================== app
@asynccontextmanager
async def lifespan(_app):
    yield
    neo4j_queries.close_driver()


app = FastAPI(title="University Timetable API", version="1.0", lifespan=lifespan)
api = APIRouter(dependencies=[Depends(current_user)])     # everything on it needs a login


@app.exception_handler(mysql.connector.Error)
def mysql_error(_request, exc: mysql.connector.Error):
    errno = getattr(exc, "errno", None)
    if errno in (1044, 1142, 1143, 1370):             # privilege missing for this SQL role
        status = 403
    elif errno in (1062, 1451, 1452):                 # unique / foreign-key clash
        status = 409
    elif errno in (1045, 2003, 2005, 2013):           # cannot log in / reach the server
        status = 503
    else:
        status = 400
    return JSONResponse({"detail": utils.describe_mysql_error(exc)}, status_code=status)


@app.exception_handler(generator.SubstitutionError)
def substitution_error(_request, exc: generator.SubstitutionError):
    return JSONResponse({"detail": str(exc)}, status_code=409)


# ==================================================================== auth
class LoginBody(BaseModel):
    username: str = Field(max_length=50)
    password: str = Field(max_length=200)


@app.post("/auth/login")
def login(body: LoginBody, response: Response):
    user = auth.authenticate(body.username.strip(), body.password)
    if user is None:
        raise HTTPException(401, "Wrong username or password.")
    # secure=False so it works on http://localhost; put the app behind HTTPS (and set secure) in production
    response.set_cookie(auth.COOKIE, auth.make_token(user, SECRET), max_age=auth.SESSION_SECONDS,
                        httponly=True, samesite="lax", path="/")
    return {"user": auth.public(user)}


@app.post("/auth/logout", status_code=204)
def logout():
    response = Response(status_code=204)
    response.delete_cookie(auth.COOKIE, path="/")
    return response


@app.get("/auth/me")
def me(user: Annotated[dict, Depends(current_user)]):
    return auth.public(user)


@app.get("/health")
def health():
    try:
        with db.connection() as conn:
            db.query(conn, "SELECT 1 AS ok")
        mysql_ok = True
    except Exception:                                 # noqa: BLE001
        mysql_ok = False
    return {"mysql": mysql_ok, "neo4j": neo4j_status()[0]}


# ============================================================ select boxes
SECTION_OPTIONS = ("SELECT s.section_id AS id, CONCAT(d.dept_name, ' / Sem ', s.semester, ' / ', s.section_name) "
                   "AS label FROM Section s JOIN Department d ON d.dept_id = s.dept_id "
                   "ORDER BY d.dept_name, s.semester, s.section_name")


@api.get("/meta")
def meta(conn: DbConn):
    q = lambda sql: db.query(conn, sql)
    counts = {r["y"]: r["n"] for r in q("SELECT academic_year AS y, COUNT(*) AS n FROM Timetable "
                                        "GROUP BY academic_year")}
    default = utils.academic_year()
    years = sorted(set(counts) | {default}, reverse=True)
    ok, detail = neo4j_status()
    return clean({
        "default_year": default,
        "years": years,
        "days": DAYS,
        "sections": q(SECTION_OPTIONS),
        "faculty": q("SELECT f.faculty_id AS id, CONCAT(f.name, ' (', d.dept_name, ')') AS label, f.name "
                     "FROM Faculty f JOIN Department d ON d.dept_id = f.dept_id ORDER BY d.dept_name, f.name"),
        "rooms": q("SELECT room_id AS id, CONCAT(building, ' ', room_no, ' (', room_type, ', ', capacity, "
                   "' seats)') AS label FROM Classroom ORDER BY building, room_no"),
        "courses": q("SELECT course_id AS id, CONCAT(course_id, ' ', course_name, ' (', course_type, ')') AS label "
                     "FROM Course ORDER BY course_id"),
        "slots": q("SELECT slot_id AS id, CONCAT(day_of_week, ' P', period_no, ' ', TIME_FORMAT(start_time, "
                   "'%H:%i')) AS label, day_of_week, period_no, start_time, end_time FROM TimeSlot ORDER BY slot_id"),
        "neo4j": {"ok": ok, "detail": detail},
        "counts": {y: counts.get(y, 0) for y in years},
    })


# =============================================================== timetable
def _sec(r: dict) -> str:
    return f"{utils.dept_code(r['dept_name'])} Sem {r['semester']} {r['section_name']}"


# view -> (column, lines shown in each grid block)
VIEWS = {
    "section": ("section_id", lambda r: [r["course_id"], r["faculty_name"], f"{r['building']} {r['room_no']}"]),
    "faculty": ("faculty_id", lambda r: [r["course_id"], _sec(r), f"{r['building']} {r['room_no']}"]),
    "room": ("room_id", lambda r: [r["course_id"], _sec(r), r["faculty_name"]]),
}


@api.get("/timetable")
def timetable(conn: DbConn, entity_id: EntityId, view: str = "section", year: Year = None):
    if view not in VIEWS:
        raise HTTPException(400, f"view must be one of {sorted(VIEWS)}")
    col, lines = VIEWS[view]
    slots = db.query(conn, "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot "
                           "ORDER BY slot_id")
    rows = clean(db.query(conn, f"SELECT * FROM v_section_timetable WHERE academic_year = %s AND {col} = %s",
                          (year_or_default(year), entity_id)))
    rows.sort(key=lambda r: (DAYS.index(r["day_of_week"]), r["period_no"]))
    grid = utils.build_week_grid(slots, [{**r, "lines": lines(r)} for r in rows])
    return {"grid": clean(grid), "rows": rows,
            "metrics": {"periods": len(rows), "courses": len({r["course_id"] for r in rows}),
                        "days": len({r["day_of_week"] for r in rows})}}


@api.get("/free-blocks")
def free_blocks(conn: DbConn, kind: str, entity_id: EntityId, year: Year = None):
    """Maximal runs of free periods (sp_free_blocks, a recursive CTE)."""
    kind = kind.upper()
    if kind not in ("FACULTY", "ROOM"):
        raise HTTPException(400, "kind must be FACULTY or ROOM")
    return clean(db.call_procedure(conn, "sp_free_blocks", (year_or_default(year), kind, entity_id)))


# =============================================================== generator
class GeneratorBody(BaseModel):
    year: str | None = Field(default=None, max_length=9)
    replace: bool = False
    allow_partial: bool = False
    dry_run: bool = False
    time_limit: float = Field(default=30, ge=5, le=120)
    seed: int = 42


@api.post("/generator")
def run_generator(body: GeneratorBody, conn: AdminConn):
    """Admin only. Build (and unless dry_run, save) a timetable."""
    res = generator.generate_timetable(year_or_default(body.year), replace=body.replace,
                                       allow_partial=body.allow_partial, dry_run=body.dry_run,
                                       time_limit=body.time_limit, seed=body.seed, conn=conn)
    status = "COMPLETE" if res.complete else ("PARTIAL" if res.placed else "FAILED")
    return clean({"status": status, "academic_year": res.academic_year, "placed": res.placed,
                  "required": res.required, "complete": res.complete, "committed": res.committed,
                  "nodes": res.nodes, "attempts": res.attempts, "elapsed": round(res.elapsed, 3),
                  "soft": res.soft, "preflight": res.preflight, "unplaced": res.unplaced,
                  "error": res.error, "note": res.note, "report": res.report(),
                  "max_fac_consec": generator.MAX_FAC_CONSEC})


class YearBody(BaseModel):
    year: str | None = Field(default=None, max_length=9)


@api.post("/etl", dependencies=[Depends(require_admin)])
def etl(body: YearBody):
    """Admin only. Refresh the Neo4j graph from MySQL (one year; every year when year is null)."""
    lines: list[str] = []
    result = neo4j_call(neo4j_etl.run_etl, body.year or None, log=lines.append, role="admin")
    return {"ok": result["ok"], "problems": result["problems"], "log": lines}


# ========================================================== faculty absent
@api.get("/absence")
def absence(conn: DbConn, faculty_id: int, year: Year = None, day: str | None = None):
    """Affected classes + substitute candidates (Neo4j), plus a note when the graph is out of date."""
    year = year_or_default(year)
    plan = neo4j_call(neo4j_queries.faculty_absence_plan, faculty_id, year, day or None)
    plan["stale"] = graph_stale_message(conn, year)
    return clean(plan)


class SubstitutionBody(BaseModel):
    timetable_id: int
    faculty_id: int
    add_teaches: bool = False


class Change(BaseModel):
    """The change record returned by generator.assign_substitute()."""
    timetable_id: int
    academic_year: str
    course_id: str
    section_id: int
    slot_id: int
    old_faculty_id: int
    old_faculty: str
    new_faculty_id: int
    new_faculty: str
    teaches_added: bool


class UndoBody(BaseModel):
    change: Change


@api.post("/substitutions")
def substitute(body: SubstitutionBody, conn: AdminConn):
    """Admin only. Hand a class to a substitute in MySQL, then refresh the graph for that year."""
    change = generator.assign_substitute(conn, body.timetable_id, body.faculty_id, add_teaches=body.add_teaches)
    return {"change": change, "graph_problem": refresh_graph(change["academic_year"])}


@api.post("/substitutions/undo")
def undo_substitution(body: UndoBody, conn: AdminConn):
    """Admin only. Revert a substitution (and the Teaches row it added)."""
    change = generator.revert_substitution(conn, body.change.model_dump())
    return {"change": change, "graph_problem": refresh_graph(change["academic_year"])}


# =========================================================== clash checker
@api.get("/clashes")
def clashes(conn: DbConn, year: Year = None):
    year = year_or_default(year)
    n = count_classes(conn, year)
    if n == 0:
        return {"classes": 0, "clashes": [], "gaps": []}
    return clean({"classes": n, "clashes": db.call_procedure(conn, "sp_list_clashes", (year,)),
                  "gaps": db.call_procedure(conn, "sp_hours_coverage", (year,))})


class CheckBody(BaseModel):
    year: str | None = Field(default=None, max_length=9)
    section_id: int
    course_id: str = Field(max_length=10)
    faculty_id: int
    room_id: int
    slot_id: int


@api.post("/clashes/check")
def check_class(body: CheckBody, conn: DbConn):
    """Would MySQL accept this class? Read-only, so faculty may use it too."""
    results = generator.check_proposed_class(conn, year_or_default(body.year), body.section_id, body.course_id,
                                             body.faculty_id, body.room_id, body.slot_id)
    hard = sum(1 for r in results if not r["ok"] and r["hard"])
    return {"accepted": hard == 0, "hard_broken": hard, "results": results}


@api.get("/sections/{section_id}/classes")
def section_classes(conn: DbConn, section_id: int, year: Year = None):
    return clean(db.query(conn, "SELECT t.timetable_id, ts.day_of_week, ts.period_no, t.course_id, f.name AS faculty "
                                "FROM Timetable t JOIN TimeSlot ts ON ts.slot_id = t.slot_id "
                                "JOIN Faculty f ON f.faculty_id = t.faculty_id "
                                "WHERE t.academic_year = %s AND t.section_id = %s ORDER BY ts.slot_id",
                          (year_or_default(year), section_id)))


@api.get("/ripple")
def ripple(timetable_id: int, day: str, period: Annotated[int, Query(ge=1, le=8)]):
    """What collides if this class moves to (day, period)? (Neo4j)"""
    return clean(neo4j_call(neo4j_queries.move_class_ripple, timetable_id, day, period))


# ============================================================== statistics
@api.get("/stats")
def stats(conn: DbConn, year: Year = None):
    year = year_or_default(year)
    q = lambda sql: db.query(conn, sql, (year,))
    by_day = q("SELECT ts.day_of_week AS day, COUNT(*) AS classes FROM Timetable t "
               "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = %s GROUP BY ts.day_of_week")
    by_day.sort(key=lambda r: DAYS.index(r["day"]))
    try:
        graph = {"conflicted": neo4j_call(neo4j_queries.most_conflicted_courses, 10),
                 "bridges": neo4j_call(neo4j_queries.cross_department_teaching)}
    except HTTPException as exc:
        graph = {"error": exc.detail}
    return clean({
        "classes": count_classes(conn, year),
        "workload": db.call_procedure(conn, "sp_faculty_workload", (year,)),
        "rooms": db.call_procedure(conn, "sp_room_utilization", (year,)),
        "by_day": by_day,
        "by_period": q("SELECT ts.period_no AS period, COUNT(*) AS classes FROM Timetable t "
                       "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = %s "
                       "GROUP BY ts.period_no ORDER BY ts.period_no"),
        "kinds": q("SELECT c.course_type AS type, COUNT(*) AS classes FROM Timetable t "
                   "JOIN Course c ON c.course_id = t.course_id WHERE t.academic_year = %s "
                   "GROUP BY c.course_type ORDER BY c.course_type"),
        "section_load": q("SELECT CONCAT(dept_name, ' S', semester, section_name) AS section, day_of_week AS day, "
                          "COUNT(*) AS n FROM v_section_timetable WHERE academic_year = %s "
                          "GROUP BY dept_name, semester, section_name, day_of_week "
                          "ORDER BY dept_name, semester, section_name"),
        "departments": db.call_procedure(conn, "sp_department_summary", (year,)),
        "graph": graph,
    })


# ================================================== Neo4j graph (read / CRUD)
@api.get("/graph/nodes")
def graph_nodes(label: str, search: str | None = None, limit: Annotated[int, Query(ge=1, le=500)] = 50):
    return clean(neo4j_call(neo4j_queries.browse_nodes, label, search, limit))


@api.get("/graph/neighbours")
def graph_neighbours(label: str, key: str, limit: Annotated[int, Query(ge=1, le=500)] = 200):
    return clean(neo4j_call(neo4j_queries.node_neighbours, label, key, limit))


@api.get("/graph/unavailability")
def graph_unavailability(faculty_id: int | None = None):
    return clean(neo4j_call(neo4j_queries.list_unavailability, faculty_id))


class MarkBody(BaseModel):
    faculty_id: int
    slot_id: int
    reason: str = Field(default="", max_length=neo4j_queries.MAX_REASON)


@api.put("/graph/unavailability", dependencies=[Depends(require_admin)])
def set_mark(body: MarkBody):
    """Admin only. Create or update an UNAVAILABLE_AT mark."""
    return clean(neo4j_call(neo4j_queries.set_unavailability, body.faculty_id, body.slot_id, body.reason))


@api.delete("/graph/unavailability", dependencies=[Depends(require_admin)])
def delete_mark(faculty_id: int, slot_id: int):
    """Admin only. Remove an UNAVAILABLE_AT mark."""
    return {"deleted": neo4j_call(neo4j_queries.delete_unavailability, faculty_id, slot_id)}


app.include_router(api)
