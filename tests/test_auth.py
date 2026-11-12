"""Password hashing and signed session tokens (pure Python, no database)."""
import base64
import json
import re

from api import auth
from conftest import ROOT

SECRET = "unit-test-secret"
USER = {"user_id": 7, "role": "faculty", "faculty_id": 3}


def test_hash_and_verify():
    h = auth.hash_password("s3cret pw", iterations=1000)
    assert re.fullmatch(r"pbkdf2_sha256\$1000\$[\w-]+\$[\w-]+", h) and "s3cret" not in h
    assert auth.verify_password("s3cret pw", h)


def test_wrong_password_is_rejected():
    h = auth.hash_password("right", iterations=1000)
    assert not auth.verify_password("wrong", h)
    assert not auth.verify_password("Right", h)
    assert not auth.verify_password("", h)


def test_every_hash_has_its_own_salt():
    a, b = auth.hash_password("same", iterations=1000), auth.hash_password("same", iterations=1000)
    assert a != b and auth.verify_password("same", a) and auth.verify_password("same", b)


def test_malformed_hashes_never_verify():
    for stored in ("", "garbage", "md5$1000$abc$def", "pbkdf2_sha256$x$abc$def", "pbkdf2_sha256$1000$abc"):
        assert not auth.verify_password("anything", stored)


def test_seeded_demo_users_have_the_documented_passwords():
    sql = (ROOT / "sql" / "06_auth_roles.sql").read_text()
    seeds = dict(re.findall(r"\('(\w+)',\s+'(pbkdf2_sha256\$[^']+)'", sql))
    assert set(seeds) == {"admin", "faculty1", "faculty2"}
    assert auth.verify_password("admin123", seeds["admin"])
    assert auth.verify_password("faculty123", seeds["faculty1"]) and auth.verify_password("faculty123", seeds["faculty2"])


def test_token_roundtrip():
    payload = auth.read_token(auth.make_token(USER, SECRET), SECRET)
    assert payload["uid"] == 7 and payload["role"] == "faculty" and payload["fid"] == 3


def test_tampered_tokens_are_rejected():
    token = auth.make_token(USER, SECRET)
    body, sig = token.split(".")
    forged = base64.urlsafe_b64encode(json.dumps({**json.loads(base64.urlsafe_b64decode(body + "==")),
                                                  "role": "admin"}).encode()).decode().rstrip("=")
    assert auth.read_token(f"{forged}.{sig}", SECRET) is None          # payload changed, old signature
    assert auth.read_token(f"{body}.{sig[:-2]}AA", SECRET) is None      # signature changed
    assert auth.read_token(token, "another-secret") is None             # signed with a different secret
    for junk in (None, "", "no-dot", "a.b.c", "!!.??"):
        assert auth.read_token(junk, SECRET) is None


def test_expired_tokens_are_rejected():
    token = auth.make_token(USER, SECRET, ttl=60, now=1_000_000)
    assert auth.read_token(token, SECRET, now=1_000_059) is not None
    assert auth.read_token(token, SECRET, now=1_000_060) is None
    assert auth.read_token(token, SECRET, now=2_000_000) is None
