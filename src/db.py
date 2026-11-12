"""
db.py -- MySQL connection helpers.

All credentials come from environment variables (or a .env file, loaded by
utils.load_env):
    MYSQL_HOST         default 127.0.0.1
    MYSQL_PORT         default 3306
    MYSQL_USER         required
    MYSQL_PASSWORD     required (may be empty for a passwordless local user)
    MYSQL_DATABASE     default university_timetable
    MYSQL_UNIX_SOCKET  optional; if set, connect through this socket instead
                       of TCP (handy for a local MariaDB/MySQL install)

Role accounts (used by the web API, see sql/06_auth_roles.sql):
    MYSQL_ADMIN_USER / MYSQL_ADMIN_PASSWORD      account holding the SQL role tt_admin
    MYSQL_FACULTY_USER / MYSQL_FACULTY_PASSWORD  account holding the SQL role tt_faculty
connect(role="admin" | "faculty") logs in as that account and runs SET ROLE, so the
session has exactly that role's privileges. role=None uses the service account above.
"""
from __future__ import annotations

import os
from contextlib import contextmanager

import mysql.connector

import utils

utils.load_env()


# role -> (user variable, default user, password variable, SQL role)
ROLE_ACCOUNTS = {
    "admin": ("MYSQL_ADMIN_USER", "tt_admin_app", "MYSQL_ADMIN_PASSWORD", "tt_admin"),
    "faculty": ("MYSQL_FACULTY_USER", "tt_faculty_app", "MYSQL_FACULTY_PASSWORD", "tt_faculty"),
}


def connect(autocommit: bool = False, role: str | None = None):
    """
    Open a new connection. autocommit=False so callers control transactions.
    role=None: the service account (MYSQL_USER). role="admin"/"faculty": that role's account,
    with the SQL role activated (SET ROLE) before the database is selected.
    """
    if role is None:
        user = os.environ.get("MYSQL_USER")
        if not user:
            raise RuntimeError(
                "MYSQL_USER is not set. Copy .env.example to .env and fill it in "
                "(or export the MYSQL_* variables).")
        password = os.environ.get("MYSQL_PASSWORD", "")
    elif role in ROLE_ACCOUNTS:
        user_var, default_user, password_var, _ = ROLE_ACCOUNTS[role]
        user, password = os.environ.get(user_var, default_user), os.environ.get(password_var, "")
    else:
        raise ValueError(f"role must be None, 'admin' or 'faculty', got {role!r}")
    database = os.environ.get("MYSQL_DATABASE", "university_timetable")
    params = dict(user=user, password=password, autocommit=autocommit, charset="utf8mb4")
    if role is None:
        params["database"] = database
    sock = os.environ.get("MYSQL_UNIX_SOCKET")
    if sock:
        params["unix_socket"] = sock
    else:
        params["host"] = os.environ.get("MYSQL_HOST", "127.0.0.1")
        params["port"] = int(os.environ.get("MYSQL_PORT", "3306"))
    conn = mysql.connector.connect(**params)
    if role is not None:
        # A role account has no privileges until its role is active, so it cannot even
        # select the database at login: activate the role first, then USE the database.
        try:
            cur = conn.cursor()
            cur.execute(f"SET ROLE {ROLE_ACCOUNTS[role][3]}")
            cur.execute(f"USE `{database}`")
            cur.close()
        except Exception:
            conn.close()
            raise
    return conn


@contextmanager
def connection(autocommit: bool = False, role: str | None = None):
    """`with connection() as conn:` -- always closes the connection."""
    conn = connect(autocommit=autocommit, role=role)
    try:
        yield conn
    finally:
        conn.close()


def query(conn, sql: str, params=None) -> list[dict]:
    """Run a SELECT and return rows as a list of dicts."""
    cur = conn.cursor(dictionary=True)
    try:
        cur.execute(sql, params or ())
        return cur.fetchall()
    finally:
        cur.close()


def call_procedure(conn, name: str, args=()) -> list[dict]:
    """
    Call a stored procedure and return the rows of its (first) result set.
    Used for sp_list_clashes, sp_faculty_workload, ...
    """
    cur = conn.cursor(dictionary=True)
    try:
        cur.callproc(name, list(args))
        # mysql-connector 26.x deprecates stored_results() in favour of a property of the
        # same name; support both so a future upgrade does not break this.
        results = cur.stored_results
        results = results() if callable(results) else results
        rows: list[dict] = []
        for result in results:
            rows = result.fetchall()
            break
        return rows
    finally:
        cur.close()


@contextmanager
def transaction(conn):
    """
    `with transaction(conn):` -- commit on success, rollback on any exception.
    The exception is re-raised so the caller can report it.
    """
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
