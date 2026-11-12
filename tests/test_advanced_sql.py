"""
sql/05_advanced_sql.sql: the stored function, the CTE procedure and the recursive CTE.
Read-only against the real year, plus an empty throw-away year.
"""
import mysql.connector
import pytest

import db
import utils


def all_slots(conn):
    return db.query(conn, "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot")


def test_fn_faculty_load_equals_count_of_timetable_rows(conn, year):
    rows = db.query(conn, "SELECT f.faculty_id, fn_faculty_load(f.faculty_id, %s) AS fn, "
                          "(SELECT COUNT(*) FROM Timetable t WHERE t.faculty_id = f.faculty_id "
                          "AND t.academic_year = %s) AS n FROM Faculty f", (year, year))
    assert rows and all(r["fn"] == r["n"] for r in rows)
    assert db.query(conn, "SELECT fn_faculty_load(1, 'no-year') AS n")[0]["n"] == 0


def test_department_summary_totals_match_the_timetable(conn, year):
    rows = db.call_procedure(conn, "sp_department_summary", (year,))
    one = lambda sql, params=(): db.query(conn, sql, params)[0]["n"]
    classes = one("SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = %s", (year,))
    assert len(rows) == one("SELECT COUNT(*) AS n FROM Department")
    assert sum(r["total_periods"] for r in rows) == classes
    assert sum(r["classes_scheduled"] for r in rows) == classes
    assert sum(r["faculty_count"] for r in rows) == one("SELECT COUNT(*) AS n FROM Faculty")
    assert sum(r["sections"] for r in rows) == one("SELECT COUNT(*) AS n FROM Section")
    for r in rows:
        loads = [x["n"] for x in db.query(conn, "SELECT fn_faculty_load(faculty_id, %s) AS n FROM Faculty "
                                                "WHERE dept_id = %s", (year, r["dept_id"]))]
        assert r["teaching_faculty"] == sum(1 for n in loads if n > 0)
        assert float(r["avg_load"]) == pytest.approx(sum(loads) / len(loads), abs=0.01)
        assert r["busiest_load"] == (max(loads) or None)


def check_free_blocks(conn, year, kind, rid):
    """Blocks are disjoint, maximal, never cross lunch, and blocks + busy slots = every slot."""
    slots = all_slots(conn)
    by_key = {(s["day_of_week"], s["period_no"]): s for s in slots}
    nxt, prv = utils.build_slot_links(slots)
    col = "faculty_id" if kind == "FACULTY" else "room_id"
    busy = {r["slot_id"] for r in db.query(conn, f"SELECT slot_id FROM Timetable WHERE academic_year = %s "
                                                 f"AND {col} = %s", (year, rid))}
    covered: list[int] = []
    for b in db.call_procedure(conn, "sp_free_blocks", (year, kind, rid)):
        ids = [by_key[(b["day_of_week"], p)]["slot_id"] for p in range(b["start_period"], b["end_period"] + 1)]
        assert b["length"] == len(ids) >= 1
        assert b["start_time"] == by_key[(b["day_of_week"], b["start_period"])]["start_time"]
        assert b["end_time"] == by_key[(b["day_of_week"], b["end_period"])]["end_time"]
        assert all(nxt.get(a) == c for a, c in zip(ids, ids[1:])), b          # consecutive, no lunch inside
        assert prv.get(ids[0]) is None or prv[ids[0]] in busy, b               # maximal at the start
        assert nxt.get(ids[-1]) is None or nxt[ids[-1]] in busy, b             # ... and at the end
        covered += ids
    assert len(covered) == len(set(covered))                                    # disjoint
    assert set(covered) | busy == {s["slot_id"] for s in slots} and not set(covered) & busy


def test_free_blocks_of_every_faculty_member_and_room(conn, year):
    for f in db.query(conn, "SELECT faculty_id FROM Faculty"):
        check_free_blocks(conn, year, "FACULTY", f["faculty_id"])
    for r in db.query(conn, "SELECT room_id FROM Classroom"):
        check_free_blocks(conn, year, "ROOM", r["room_id"])


def test_free_blocks_of_an_empty_year_are_the_half_days(conn, clean_test_year):
    """Nothing booked: each day splits into exactly two blocks at lunch (P1-P4, P5-P8 with the seed slots)."""
    check_free_blocks(conn, clean_test_year, "ROOM", 1)
    blocks = db.call_procedure(conn, "sp_free_blocks", (clean_test_year, "ROOM", 1))
    days = {s["day_of_week"] for s in all_slots(conn)}
    assert [(b["start_period"], b["end_period"]) for b in blocks] == [(1, 4), (5, 8)] * len(days)
    assert [b["day_of_week"] for b in blocks] == sorted([d for d in days for _ in (0, 1)], key=utils.DAY_ORDER.index)


def test_free_blocks_rejects_an_unknown_kind(conn, year):
    with pytest.raises(mysql.connector.Error) as err:
        db.call_procedure(conn, "sp_free_blocks", (year, "STUDENT", 1))
    assert "FACULTY or ROOM" in str(err.value)
