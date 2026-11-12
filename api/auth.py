"""
auth.py -- password hashing, signed session tokens and AppUser lookup.

  * Passwords: PBKDF2-HMAC-SHA256 (stdlib), stored as
        pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
  * Sessions: a token  base64url(json{uid, role, fid, exp}) "." base64url(hmac_sha256)
    signed with APP_SECRET, kept in the httpOnly cookie `tt_session` for 8 hours.
  * Users live in the AppUser table (sql/06_auth_roles.sql). They are looked up with the
    service account (MYSQL_USER); everything else runs on a role account (see db.connect).

CLI:   python -m api.auth hash <password>     # print a hash for a seed row / a new user
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import db  # noqa: E402
import utils  # noqa: E402

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 200_000
COOKIE = "tt_session"
SESSION_SECONDS = 8 * 3600


# ------------------------------------------------------------------ passwords
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def hash_password(password: str, iterations: int = ITERATIONS, salt: bytes | None = None) -> str:
    """PBKDF2-SHA256 hash with a random 16-byte salt."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"{ALGORITHM}${iterations}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """True when `password` matches the stored hash (constant-time compare)."""
    try:
        algorithm, iterations, salt, digest = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        got = hashlib.pbkdf2_hmac("sha256", password.encode(), _unb64(salt), int(iterations))
        return hmac.compare_digest(got, _unb64(digest))
    except (ValueError, TypeError):
        return False


# ------------------------------------------------------------------- tokens
def app_secret() -> str:
    """APP_SECRET from the environment / .env. The API refuses to start without one."""
    secret = utils.env("APP_SECRET", "")
    if not secret:
        raise RuntimeError("APP_SECRET is not set. Put a long random string in .env "
                           "(python -c 'import secrets; print(secrets.token_urlsafe(32))').")
    return secret


def _sign(body: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def make_token(user: dict, secret: str, ttl: int = SESSION_SECONDS, now: float | None = None) -> str:
    """Signed session token for an AppUser row."""
    payload = {"uid": user["user_id"], "role": user["role"], "fid": user.get("faculty_id"),
               "exp": int((now or time.time()) + ttl)}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body, secret)}"


def read_token(token: str | None, secret: str, now: float | None = None) -> dict | None:
    """The token's payload, or None when it is missing, tampered with or expired."""
    if not token or token.count(".") != 1:
        return None
    body, sig = token.split(".")
    if not hmac.compare_digest(sig, _sign(body, secret)):
        return None
    try:
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("exp", 0) <= (now or time.time()):
        return None
    return payload


# -------------------------------------------------------------------- users
_USER_SQL = ("SELECT u.user_id, u.username, u.password_hash, u.role, u.faculty_id, u.is_active, "
             "f.name AS faculty_name FROM AppUser u LEFT JOIN Faculty f ON f.faculty_id = u.faculty_id ")


def public(user: dict) -> dict:
    """The fields the API returns for a user (never the hash)."""
    return {k: user[k] for k in ("user_id", "username", "role", "faculty_id", "faculty_name")}


def get_user(user_id: int) -> dict | None:
    """Active AppUser by id (service account), or None."""
    with db.connection() as conn:
        rows = db.query(conn, _USER_SQL + "WHERE u.user_id = %s AND u.is_active", (user_id,))
    return rows[0] if rows else None


def authenticate(username: str, password: str) -> dict | None:
    """Check a login; on success record last_login and return the user row."""
    with db.connection() as conn:
        rows = db.query(conn, _USER_SQL + "WHERE u.username = %s AND u.is_active", (username,))
        if not rows or not verify_password(password, rows[0]["password_hash"]):
            return None
        cur = conn.cursor()
        cur.execute("UPDATE AppUser SET last_login = CURRENT_TIMESTAMP WHERE user_id = %s", (rows[0]["user_id"],))
        conn.commit()
        cur.close()
    return rows[0]


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "hash":
        print(hash_password(sys.argv[2]))
    else:
        print("usage: python -m api.auth hash <password>")
        sys.exit(2)
