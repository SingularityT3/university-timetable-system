"""
The FastAPI backend (api/main.py) through FastAPI's TestClient.

Logins use the seeded demo users; their last_login is restored afterwards. Writes only
touch TEST_YEAR (substitution) or a Neo4j mark the test creates and deletes again.
"""
import pytest
from fastapi.testclient import TestClient

import db
import neo4j_queries as NQ
from api import auth
from api import main as M
from conftest import TEST_YEAR

ADMIN_ONLY = [
    ("POST", "/generator", {"dry_run": True}),
    ("POST", "/etl", {"year": TEST_YEAR}),
    ("POST", "/substitutions", {"timetable_id": 1, "faculty_id": 2}),
    ("POST", "/substitutions/undo", {"change": {
        "timetable_id": 1, "academic_year": TEST_YEAR, "course_id": "X", "section_id": 1, "slot_id": 1,
        "old_faculty_id": 1, "old_faculty": "a", "new_faculty_id": 2, "new_faculty": "b", "teaches_added": False}}),
    ("PUT", "/graph/unavailability", {"faculty_id": 1, "slot_id": 1, "reason": "x"}),
    ("DELETE", "/graph/unavailability?faculty_id=1&slot_id=1", None),
]


@pytest.fixture(scope="module", autouse=True)
def keep_last_login():
    """Logging in stamps AppUser.last_login: put the old values back afterwards."""
    with db.connection() as c:
        before = db.query(c, "SELECT user_id, last_login FROM AppUser")
    yield
    with db.connection(autocommit=True) as c:
        cur = c.cursor()
        for r in before:
            cur.execute("UPDATE AppUser SET last_login = %s WHERE user_id = %s", (r["last_login"], r["user_id"]))
        cur.close()


def login(username, password):
    client = TestClient(M.app)
    r = client.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture(scope="module")
def admin():
    return login("admin", "admin123")


@pytest.fixture(scope="module")
def faculty():
    return login("faculty1", "faculty123")


# ------------------------------------------------------------------- auth
def test_login_sets_an_http_only_session_cookie():
    r = TestClient(M.app).post("/auth/login", json={"username": "faculty1", "password": "faculty123"})
    user = r.json()["user"]
    assert r.status_code == 200 and set(user) == {"user_id", "username", "role", "faculty_id", "faculty_name"}
    assert (user["username"], user["role"], user["faculty_id"]) == ("faculty1", "faculty", 1)
    cookie = r.headers["set-cookie"].lower()
    assert cookie.startswith(f"{auth.COOKIE}=") and "httponly" in cookie and "samesite=lax" in cookie


@pytest.mark.parametrize("username, password", [("admin", "wrong"), ("nobody", "admin123"), ("", "")])
def test_bad_login_is_401(username, password):
    r = TestClient(M.app).post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 401 and "detail" in r.json() and auth.COOKIE not in r.cookies


def test_me_returns_the_logged_in_user(admin, faculty):
    assert admin.get("/auth/me").json()["role"] == "admin"
    me = faculty.get("/auth/me").json()
    assert me["role"] == "faculty" and me["faculty_id"] == 1 and me["faculty_name"]


@pytest.mark.parametrize("path", ["/auth/me", "/meta", "/timetable?id=1", "/stats", "/graph/nodes?label=Faculty"])
def test_routes_need_a_login(path):
    client = TestClient(M.app)
    assert client.get(path).status_code == 401
    client.cookies.set(auth.COOKIE, "forged.token")
    assert client.get(path).status_code == 401


def test_expired_session_is_401(admin):
    user = {"user_id": admin.get("/auth/me").json()["user_id"], "role": "admin"}
    client = TestClient(M.app)
    client.cookies.set(auth.COOKIE, auth.make_token(user, M.SECRET, ttl=-1))
    assert client.get("/auth/me").status_code == 401
    client.cookies.set(auth.COOKIE, auth.make_token(user, M.SECRET))
    assert client.get("/auth/me").status_code == 200


def test_logout_clears_the_cookie():
    client = login("faculty2", "faculty123")
    r = client.post("/auth/logout")
    assert r.status_code == 204 and f"{auth.COOKIE}=" in r.headers["set-cookie"]
    assert client.get("/auth/me").status_code == 401


@pytest.mark.parametrize("method, path, body", ADMIN_ONLY)
def test_faculty_gets_403_on_admin_routes(faculty, method, path, body):
    r = faculty.request(method, path, json=body)
    assert r.status_code == 403, r.text


def test_health_needs_no_login():
    r = TestClient(M.app).get("/health")
    assert r.status_code == 200 and r.json()["mysql"] is True and isinstance(r.json()["neo4j"], bool)


# ------------------------------------------------------------- read routes
def test_meta_shape(faculty, year):
    m = faculty.get("/meta").json()
    assert m["default_year"] == year and year in m["years"] and m["years"] == sorted(m["years"], reverse=True)
    assert m["days"] == ["MON", "TUE", "WED", "THU", "FRI", "SAT"]
    for key in ("sections", "faculty", "rooms", "courses", "slots"):
        assert m[key] and {"id", "label"} <= set(m[key][0]), key
    assert m["faculty"][0]["name"] and m["slots"][0]["start_time"] == "08:30"
    assert set(m["neo4j"]) == {"ok", "detail"} and set(m["counts"]) == set(m["years"])


@pytest.mark.parametrize("view, entity, second_line", [("section", 1, "faculty_name"), ("faculty", 1, "section"),
                                                       ("room", 1, "section")])
def test_timetable_views(faculty, conn, year, view, entity, second_line):
    r = faculty.get(f"/timetable?view={view}&id={entity}&year={year}").json()
    col = {"section": "section_id", "faculty": "faculty_id", "room": "room_id"}[view]
    n = db.query(conn, f"SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s AND {col} = %s",
                 (year, entity))[0]["n"]
    assert r["metrics"]["periods"] == len(r["rows"]) == n
    assert r["metrics"]["days"] == len({x["day_of_week"] for x in r["rows"]})
    order = [(M.DAYS.index(x["day_of_week"]), x["period_no"]) for x in r["rows"]]
    assert order == sorted(order)
    assert [row["label"] for row in r["grid"]["rows"] if row["kind"] == "break"] == ["Lunch"]
    classes = [c for row in r["grid"]["rows"] for cell in row["cells"].values() for c in cell]
    assert len(classes) == n
    for c in classes:
        assert len(c["lines"]) == 3 and c["lines"][0] == c["course_id"] and c["course_type"] in ("THEORY", "LAB")
        if second_line == "faculty_name":
            assert c["lines"][1] == c["faculty_name"]
        else:
            assert c["lines"][1].endswith(f"Sem {c['semester']} {c['section_name']}")


def test_timetable_rejects_an_unknown_view(faculty):
    assert faculty.get("/timetable?view=student&id=1").status_code == 400


def test_free_blocks_route(faculty, year):
    rows = faculty.get(f"/free-blocks?kind=faculty&id=1&year={year}").json()
    assert rows and set(rows[0]) == {"day_of_week", "start_period", "end_period", "start_time", "end_time", "length"}
    assert ":" in rows[0]["start_time"]
    assert faculty.get("/free-blocks?kind=student&id=1").status_code == 400


def test_clashes_route(faculty, conn, year):
    r = faculty.get(f"/clashes?year={year}").json()
    n = db.query(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s", (year,))[0]["n"]
    assert r == {"classes": n, "clashes": [], "gaps": []}


def test_check_a_proposed_class(faculty, conn, year):
    """Faculty may use the what-if checker; a class in a slot its section already uses is rejected."""
    t = db.query(conn, "SELECT * FROM Timetable WHERE academic_year = %s ORDER BY timetable_id LIMIT 1", (year,))[0]
    body = {"year": year, "section_id": t["section_id"], "course_id": t["course_id"], "faculty_id": t["faculty_id"],
            "room_id": t["room_id"], "slot_id": t["slot_id"]}
    r = faculty.post("/clashes/check", json=body).json()
    assert r["accepted"] is False and r["hard_broken"] == sum(1 for x in r["results"] if x["hard"] and not x["ok"]) >= 3
    assert {"rule", "ok", "hard", "detail"} == set(r["results"][0])


def test_section_classes(faculty, year):
    rows = faculty.get(f"/sections/1/classes?year={year}").json()
    assert rows and set(rows[0]) == {"timetable_id", "day_of_week", "period_no", "course_id", "faculty"}


def test_stats_shape(faculty, conn, year):
    s = faculty.get(f"/stats?year={year}").json()
    assert {"classes", "workload", "rooms", "by_day", "by_period", "kinds", "section_load", "departments",
            "graph"} == set(s)
    assert sum(r["classes"] for r in s["by_day"]) == s["classes"] == sum(r["classes"] for r in s["by_period"])
    assert [r["day"] for r in s["by_day"]] == [d for d in M.DAYS if d in {r["day"] for r in s["by_day"]}]
    assert sum(r["total_periods"] for r in s["departments"]) == s["classes"]
    assert isinstance(s["rooms"][0]["utilization_pct"], float)
    assert set(s["graph"]) in ({"conflicted", "bridges"}, {"error"})


# ------------------------------------------------------------ admin actions
def test_generator_dry_run_changes_nothing(admin, conn, year):
    before = db.query(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s", (year,))[0]["n"]
    r = admin.post("/generator", json={"year": year, "dry_run": True, "time_limit": 20})
    assert r.status_code == 200, r.text
    g = r.json()
    assert g["status"] == "COMPLETE" and g["committed"] is False and g["note"] == "dry run"
    assert g["placed"] == g["required"] > 0 and "Academic year" in g["report"] and g["max_fac_consec"] == 3
    conn.rollback()
    assert db.query(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s", (year,))[0]["n"] == before


def test_generator_validates_the_time_limit(admin):
    assert admin.post("/generator", json={"dry_run": True, "time_limit": 500}).status_code == 422


def test_substitution_assign_and_undo(admin, conn, saved_test_year, monkeypatch):
    """Assign a qualified, free colleague to a TEST_YEAR class, then undo. The Neo4j refresh is stubbed."""
    refreshed = []
    monkeypatch.setattr(M.neo4j_etl, "run_etl", lambda year, **kw: refreshed.append((year, kw)) or {"ok": True})
    pick = db.query(conn, "SELECT t.timetable_id, t.faculty_id AS old, th.faculty_id AS new FROM Timetable t "
                          "JOIN Teaches th ON th.course_id = t.course_id AND th.faculty_id <> t.faculty_id "
                          "WHERE t.academic_year = %s AND NOT EXISTS (SELECT 1 FROM Timetable b WHERE "
                          "b.academic_year = t.academic_year AND b.slot_id = t.slot_id AND b.faculty_id = th.faculty_id) "
                          "ORDER BY t.timetable_id LIMIT 1", (TEST_YEAR,))
    if not pick:
        pytest.skip("no qualified free colleague in the generated TEST_YEAR timetable")
    tid, old, new = pick[0]["timetable_id"], pick[0]["old"], pick[0]["new"]
    faculty_of = lambda: (conn.rollback(), db.query(conn, "SELECT faculty_id FROM Timetable WHERE timetable_id = %s",
                                                    (tid,))[0]["faculty_id"])[1]

    r = admin.post("/substitutions", json={"timetable_id": tid, "faculty_id": new})
    assert r.status_code == 200, r.text
    change = r.json()["change"]
    assert r.json()["graph_problem"] is None and change["teaches_added"] is False
    assert faculty_of() == new
    assert [y for y, _ in refreshed] == [TEST_YEAR] and refreshed[0][1]["role"] == "admin"   # graph refresh asked

    again = admin.post("/substitutions", json={"timetable_id": tid, "faculty_id": new})
    assert again.status_code == 409 and "already teaches" in again.json()["detail"]

    r = admin.post("/substitutions/undo", json={"change": change})
    assert r.status_code == 200, r.text
    assert faculty_of() == old and r.json()["change"]["new_faculty_id"] == old


# -------------------------------------------------------------- Neo4j routes
def test_neo4j_down_gives_503(admin, monkeypatch):
    class ServiceUnavailable(Exception):
        pass

    def down():
        raise ServiceUnavailable("connection refused")

    monkeypatch.setattr(NQ, "get_driver", down)
    r = admin.get("/graph/nodes?label=Faculty")
    assert r.status_code == 503 and "Neo4j is not reachable" in r.json()["detail"]
    assert admin.get("/absence?faculty_id=1").status_code == 503
    assert admin.get("/meta").json()["neo4j"] == {"ok": False, "detail": "ServiceUnavailable"}
    assert "Neo4j is not reachable" in admin.get("/stats").json()["graph"]["error"]


def test_graph_browser(faculty, graph_loaded):
    nodes = faculty.get("/graph/nodes?label=Course&search=cs3&limit=5").json()
    assert 0 < len(nodes) <= 5 and all("cs3" in n["id"].lower() or "cs3" in n["name"].lower() for n in nodes)
    assert {"id", "name", "properties", "degree"} == set(nodes[0])
    nb = faculty.get(f"/graph/neighbours?label=Course&key={nodes[0]['id']}").json()
    assert nb and {"relationship", "direction", "label", "key", "name", "properties"} == set(nb[0])
    assert faculty.get("/graph/nodes?label=Nope").status_code == 400
    assert faculty.get("/graph/neighbours?label=Faculty&key=abc").status_code == 400


def test_absence_and_ripple(faculty, conn, year, graph_loaded):
    plan = faculty.get(f"/absence?faculty_id=1&year={year}&day=").json()
    assert {"classes", "summary", "stale"} <= set(plan)
    t = db.query(conn, "SELECT timetable_id FROM Timetable WHERE academic_year = %s LIMIT 1", (year,))[0]
    r = faculty.get(f"/ripple?timetable_id={t['timetable_id']}&day=FRI&period=8").json()
    assert {"moved", "clashes", "free_move", "students_displaced"} == set(r)
    assert faculty.get("/ripple?timetable_id=-5&day=FRI&period=8").status_code == 404


def test_unavailability_crud_via_api(admin, faculty, graph_loaded):
    fid = 20
    taken = {m["slot_id"] for m in admin.get(f"/graph/unavailability?faculty_id={fid}").json()}
    slot = next(s for s in range(48, 0, -1) if s not in taken)
    try:
        r = admin.put("/graph/unavailability", json={"faculty_id": fid, "slot_id": slot, "reason": "API test"})
        assert r.status_code == 200 and r.json()["reason"] == "API test" and r.json()["updated_at"]
        admin.put("/graph/unavailability", json={"faculty_id": fid, "slot_id": slot, "reason": "edited"})
        mine = [m for m in faculty.get(f"/graph/unavailability?faculty_id={fid}").json() if m["slot_id"] == slot]
        assert [m["reason"] for m in mine] == ["edited"]
        assert any(m["slot_id"] == slot for m in faculty.get("/graph/unavailability").json())
        assert admin.put("/graph/unavailability", json={"faculty_id": fid, "slot_id": slot,
                                                        "reason": "x" * 201}).status_code == 422
        assert admin.put("/graph/unavailability", json={"faculty_id": -1, "slot_id": slot}).status_code == 404
    finally:
        r = admin.delete(f"/graph/unavailability?faculty_id={fid}&slot_id={slot}")
    assert r.json() == {"deleted": 1}
    assert admin.delete(f"/graph/unavailability?faculty_id={fid}&slot_id={slot}").json() == {"deleted": 0}
