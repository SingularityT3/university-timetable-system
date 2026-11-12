"""
Tests against a RUNNING Neo4j whose graph was loaded by `python src/neo4j_etl.py`.
They only READ, except the unavailability tests: those create their own UNAVAILABLE_AT
mark and always delete it again. If Neo4j is down or the graph is empty they skip themselves.
"""
import pytest

import db
import neo4j_etl as E
import neo4j_queries as NQ
import utils

pytestmark = pytest.mark.neo4j


def test_graph_counts_match_mysql(conn, year, graph_loaded):
    """Every node and relationship count equals what MySQL says it should be (for every year in the graph)."""
    years = sorted({year} | set(E.graph_years(graph_loaded)))
    problems = E.compare_counts(E.expected_counts(conn, years), E.actual_counts(graph_loaded))
    assert problems == [], "graph differs from MySQL: re-run `python src/neo4j_etl.py`\n" + "\n".join(problems)


def test_derived_conflicts_equal_the_sql_definition(conn, graph_loaded):
    """CONFLICTS_WITH (built inside Neo4j) must equal utils.build_conflict_graph (built from SQL)."""
    sql_graph = utils.build_conflict_graph(conn)
    for course, neighbours in sql_graph.items():
        got = {r["course_id"]: r["shared_count"] for r in NQ.course_conflict_neighbours(course)}
        assert got == neighbours, course


def test_workload_total_equals_saved_classes(conn, year, graph_loaded):
    in_mysql = db.query(conn, "SELECT COUNT(*) v FROM Timetable WHERE academic_year = %s", (year,))[0]["v"]
    assert sum(r["periods"] for r in NQ.faculty_workload_ranking(year)) == in_mysql


def test_absence_plan_counts_every_class_of_the_teacher(conn, year, graph_loaded):
    mysql_n = db.query(conn, "SELECT COUNT(*) v FROM Timetable WHERE academic_year = %s AND faculty_id = 1",
                       (year,))[0]["v"]
    plan = NQ.faculty_absence_plan(1, year)
    assert plan["summary"]["classes_affected"] == mysql_n == len(plan["classes"])
    for c in plan["classes"]:
        assert c["status"] in {"COVERABLE", "NEEDS_TEACHES", "UNCOVERED"}
        for s in c["substitutes"]:                        # candidates really are free in that slot
            busy = db.query(conn, "SELECT COUNT(*) v FROM Timetable t JOIN Timetable m ON m.slot_id = t.slot_id "
                                  "WHERE m.timetable_id = %s AND t.faculty_id = %s AND t.academic_year = %s",
                            (c["timetable_id"], s["candidate_id"], year))[0]["v"]
            assert busy == 0


def test_free_rooms_are_exactly_the_unbooked_rooms(conn, year, graph_loaded):
    slot = db.query(conn, "SELECT slot_id FROM TimeSlot WHERE day_of_week = 'MON' AND period_no = 1")[0]["slot_id"]
    booked = {r["room_id"] for r in db.query(conn, "SELECT room_id FROM Timetable WHERE academic_year = %s "
                                                   "AND slot_id = %s", (year, slot))}
    lecture = {r["room_id"] for r in db.query(conn, "SELECT room_id FROM Classroom WHERE room_type = 'LECTURE' "
                                                    "AND capacity >= 60")}
    got = {r["room_id"] for r in NQ.free_rooms("MON", 1, 60, "LECTURE", year)}
    assert got == lecture - booked


def test_shortest_path_between_connected_and_isolated_faculty(graph_loaded):
    far = NQ.faculty_shortest_path(1, 11)                 # CSE -> ECE, linked by the cross-department teachers
    assert far["connected"] and far["path"][0]["kind"] == far["path"][-1]["kind"] == "Faculty"
    assert far["hops"] == len(far["path"]) - 1
    assert NQ.faculty_shortest_path(1, 17)["connected"] is False   # Mechanical has no cross-department link


def test_ripple_flags_a_section_clash(conn, year, graph_loaded):
    """Moving one class of a section into the slot of another class of the SAME section must clash."""
    rows = db.query(conn, "SELECT t.timetable_id, ts.day_of_week d, ts.period_no p FROM Timetable t "
                          "JOIN TimeSlot ts ON ts.slot_id = t.slot_id WHERE t.academic_year = %s AND t.section_id = 1 "
                          "ORDER BY ts.slot_id LIMIT 2", (year,))
    if len(rows) < 2:
        pytest.skip("section 1 has fewer than two classes saved")
    a, b = rows
    r = NQ.move_class_ripple(a["timetable_id"], b["d"], b["p"])
    assert not r["free_move"]
    hit = next(c for c in r["clashes"] if c["clash_timetable_id"] == b["timetable_id"])
    assert "SECTION" in hit["clash_types"] and r["students_displaced"] >= 12


def free_mark(faculty_id: int) -> int:
    """A slot this faculty member has no unavailability mark on (so the test owns the mark it makes)."""
    taken = {m["slot_id"] for m in NQ.list_unavailability(faculty_id)}
    return next(s for s in range(48, 0, -1) if s not in taken)


def test_unavailability_mark_create_update_delete(graph_loaded):
    fid = 19
    slot = free_mark(fid)
    try:
        made = NQ.set_unavailability(fid, slot, "  Conference  ")
        assert (made["faculty_id"], made["slot_id"], made["reason"]) == (fid, slot, "Conference")
        NQ.set_unavailability(fid, slot, "Medical leave")                  # MERGE: update, not a second mark
        mine = [m for m in NQ.list_unavailability(fid) if m["slot_id"] == slot]
        assert [m["reason"] for m in mine] == ["Medical leave"] and mine[0]["updated_at"]
        assert any(m["faculty_id"] == fid and m["slot_id"] == slot for m in NQ.list_unavailability())
        with pytest.raises(LookupError):
            NQ.set_unavailability(fid, 10_000, "no such slot")
    finally:
        assert NQ.delete_unavailability(fid, slot) == 1
    assert NQ.delete_unavailability(fid, slot) == 0
    assert all(m["slot_id"] != slot for m in NQ.list_unavailability(fid))


def test_substitute_finder_skips_a_colleague_marked_unavailable(conn, year, graph_loaded):
    rows = NQ.substitute_finder(1, year)
    if not rows:
        pytest.skip("faculty 1 has no substitute candidates")
    cls, cand = rows[0]["timetable_id"], rows[0]["candidate_id"]
    slot = db.query(conn, "SELECT slot_id FROM Timetable WHERE timetable_id = %s", (cls,))[0]["slot_id"]
    assert all(m["slot_id"] != slot for m in NQ.list_unavailability(cand))   # so the mark below is ours
    try:
        NQ.set_unavailability(cand, slot, "test: unavailable")
        after = NQ.substitute_finder(1, year)
        assert not any(r["timetable_id"] == cls and r["candidate_id"] == cand for r in after)
        assert len(after) == len(rows) - 1                                  # nothing else changed
    finally:
        NQ.delete_unavailability(cand, slot)
    assert any(r["timetable_id"] == cls and r["candidate_id"] == cand for r in NQ.substitute_finder(1, year))


def test_node_browser_and_neighbours(conn, graph_loaded):
    n_faculty = db.query(conn, "SELECT COUNT(*) AS n FROM Faculty")[0]["n"]
    assert len(NQ.browse_nodes("Faculty", None, 500)) == n_faculty
    rooms = NQ.browse_nodes("Classroom", "lab", 500)
    assert rooms and all("lab" in r["name"].lower() for r in rooms)
    fac = NQ.browse_nodes("Faculty", None, 1)[0]
    nb = NQ.node_neighbours("Faculty", fac["id"], 500)
    assert len(nb) == fac["degree"]
    assert {"relationship": "WORKS_IN", "direction": "OUT", "label": "Department"}.items() <= next(
        r for r in nb if r["relationship"] == "WORKS_IN").items()
