"""
Database-level RBAC (sql/06_auth_roles.sql + docker/mysql/07_role_accounts.sh): the API's
role accounts get exactly their SQL role's privileges. Writes only happen inside a
transaction that is rolled back.
"""
import os

import mysql.connector
import pytest

import db
from conftest import TEST_YEAR

READABLE = ["Department", "Faculty", "Course", "Classroom", "Section", "Student", "TimeSlot", "Teaches",
            "Enrollment", "Timetable", "Section_Course", "v_section_timetable", "v_faculty_timetable"]
DENIED = 1142                                         # "command denied to user ... for table ..."


def open_role(role):
    try:
        return db.connect(role=role)
    except mysql.connector.Error as exc:
        pytest.fail(f"Cannot log in with the {role} role account ({exc}). Create the accounts with "
                    "docker/mysql/07_role_accounts.sh (Docker does it on a fresh volume) and set "
                    "MYSQL_ADMIN_* / MYSQL_FACULTY_* in .env.", pytrace=False)


@pytest.fixture
def faculty_conn():
    c = open_role("faculty")
    yield c
    c.rollback()
    c.close()


@pytest.fixture
def admin_conn():
    c = open_role("admin")
    yield c
    c.rollback()
    c.close()


def execute(conn, sql, params=()):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        if cur.with_rows:
            cur.fetchall()
        return cur.rowcount
    finally:
        cur.close()


def test_each_account_runs_with_its_role(faculty_conn, admin_conn):
    assert "tt_faculty" in db.query(faculty_conn, "SELECT CURRENT_ROLE() AS r")[0]["r"]
    assert "tt_admin" in db.query(admin_conn, "SELECT CURRENT_ROLE() AS r")[0]["r"]


def test_role_accounts_have_no_privileges_until_the_role_is_set():
    user_var, default_user, password_var, _ = db.ROLE_ACCOUNTS["faculty"]
    params = dict(user=os.environ.get(user_var, default_user), password=os.environ.get(password_var, ""),
                  database=os.environ.get("MYSQL_DATABASE", "university_timetable"))
    if os.environ.get("MYSQL_UNIX_SOCKET"):
        params["unix_socket"] = os.environ["MYSQL_UNIX_SOCKET"]
    else:
        params.update(host=os.environ.get("MYSQL_HOST", "127.0.0.1"), port=int(os.environ.get("MYSQL_PORT", "3306")))
    with pytest.raises(mysql.connector.Error) as err:      # no role active -> not even the database is visible
        mysql.connector.connect(**params).close()
    assert err.value.errno == 1044


def test_faculty_role_can_read_the_timetable(faculty_conn, year):
    for table in READABLE:
        db.query(faculty_conn, f"SELECT COUNT(*) AS n FROM {table}")
    assert db.call_procedure(faculty_conn, "sp_faculty_workload", (year,))
    assert db.query(faculty_conn, "SELECT fn_faculty_load(1, %s) AS n", (year,))[0]["n"] >= 0


@pytest.mark.parametrize("sql", [
    "INSERT INTO Department (dept_name, building) VALUES ('Role Test Dept', 'X')",
    "UPDATE Timetable SET room_id = room_id WHERE academic_year = 'no-year'",
    "DELETE FROM Teaches WHERE faculty_id = -1",
    "SELECT * FROM AppUser",
])
def test_faculty_role_is_denied_writes_and_the_user_table(faculty_conn, sql):
    with pytest.raises(mysql.connector.Error) as err:
        execute(faculty_conn, sql)
    assert err.value.errno == DENIED, err.value


def test_admin_role_can_write(admin_conn):
    assert execute(admin_conn, "INSERT INTO Department (dept_name, building) VALUES ('Role Test Dept', 'X')") == 1
    assert execute(admin_conn, "UPDATE Department SET building = 'Y' WHERE dept_name = 'Role Test Dept'") == 1
    assert execute(admin_conn, "DELETE FROM Department WHERE dept_name = 'Role Test Dept'") == 1
    assert execute(admin_conn, "DELETE FROM Timetable WHERE academic_year = %s", (TEST_YEAR,)) >= 0
    assert db.query(admin_conn, "SELECT COUNT(*) AS n FROM AppUser")[0]["n"] >= 1
    admin_conn.rollback()
    assert not db.query(admin_conn, "SELECT 1 AS x FROM Department WHERE dept_name = 'Role Test Dept'")


def test_admin_role_has_no_ddl(admin_conn):
    try:
        with pytest.raises(mysql.connector.Error) as err:
            execute(admin_conn, "CREATE TABLE role_test_tmp (x INT)")
        assert err.value.errno == DENIED
    finally:                                          # only if the test failed: remove the table again
        with db.connection(autocommit=True) as c:
            execute(c, "DROP TABLE IF EXISTS role_test_tmp")
