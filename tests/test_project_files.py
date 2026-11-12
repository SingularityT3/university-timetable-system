"""Project hygiene: files, documentation and configuration agree with each other."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ["README.md", "requirements.txt", ".env.example", ".gitignore", "docker-compose.yml",
            "pytest.ini", "cypher/constraints.cypher", "cypher/queries.cypher",
            "docker/mysql/00_app_user.sh", "docker/mysql/07_role_accounts.sh",
            "sql/01_schema.sql", "sql/02_migration_improvements.sql", "sql/03_seed_data.sql",
            "sql/04_views_procedures.sql", "sql/05_advanced_sql.sql", "sql/06_auth_roles.sql",
            "src/db.py", "src/utils.py", "src/generator.py", "src/neo4j_etl.py", "src/neo4j_queries.py",
            "api/__init__.py", "api/auth.py", "api/main.py",
            "web/package.json", "web/package-lock.json", "web/next.config.ts", "web/middleware.ts",
            "tools/make_seed.py", "requirements-dev.txt", "ruff.toml", ".github/workflows/ci.yml"]
SQL_FILES = sorted(p.name for p in (ROOT / "sql").glob("*.sql"))


def test_required_files_are_present():
    missing = [p for p in REQUIRED if not (ROOT / p).is_file()]
    assert not missing, f"missing files (see README 'Project structure'): {missing}"


def test_env_example_documents_every_setting_the_code_reads():
    documented = set(re.findall(r"^#?\s*([A-Z0-9_]+)=", (ROOT / ".env.example").read_text(), re.M))
    sources = [*(ROOT / "src").glob("*.py"), *(ROOT / "api").glob("*.py"), ROOT / "docker-compose.yml",
               ROOT / "web" / "next.config.ts"]
    code = "".join(p.read_text() for p in sources)
    used = set(re.findall(r"""["'$\{.]((?:MYSQL|NEO4J|ACADEMIC)_[A-Z_]+|APP_SECRET|API_URL)\b""", code))
    assert used <= documented, f"not in .env.example: {sorted(used - documented)}"


def test_secrets_are_git_ignored_but_the_template_is_not():
    lines = (ROOT / ".gitignore").read_text().splitlines()
    assert ".env" in lines and "!.env.example" in lines and ".venv/" in lines
    assert "node_modules/" in lines and ".next/" in lines


def test_requirements_cover_the_imports():
    reqs = (ROOT / "requirements.txt").read_text().lower()
    for pkg in ("mysql-connector-python", "neo4j", "fastapi", "uvicorn"):
        assert pkg in reqs
    assert "httpx" in (ROOT / "requirements-dev.txt").read_text().lower()      # FastAPI's TestClient
    for gone in ("pandas", "streamlit"):                                        # the UI is web/ now
        assert not re.search(rf"^{gone}\b", reqs, re.M), f"{gone} is no longer used"


def test_web_app_has_the_documented_npm_scripts():
    scripts = json.loads((ROOT / "web" / "package.json").read_text())["scripts"]
    assert {"dev", "build", "start", "lint", "test"} <= set(scripts)


def test_every_sql_file_is_loaded_by_docker_and_ci():
    compose = (ROOT / "docker-compose.yml").read_text()
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    for name in SQL_FILES:
        assert f"./sql/{name}:/docker-entrypoint-initdb.d/{name}" in compose, f"{name} not mounted"
        assert f"sql/{name}" in ci, f"{name} not loaded in the MariaDB CI job"
    assert "07_role_accounts.sh:/docker-entrypoint-initdb.d/07_role_accounts.sh" in compose


def test_seed_file_is_exactly_what_make_seed_generates(tmp_path):
    out = tmp_path / "seed.sql"
    subprocess.run([sys.executable, str(ROOT / "tools" / "make_seed.py"), str(out)], check=True, capture_output=True)
    assert out.read_bytes() == (ROOT / "sql" / "03_seed_data.sql").read_bytes()


def test_readme_matches_the_code():
    text = (ROOT / "README.md").read_text()
    code = (ROOT / "src" / "generator.py").read_text() + (ROOT / "src" / "neo4j_etl.py").read_text()
    flags = set(re.findall(r"--[a-z][a-z-]+", text)) - {"--now", "--user", "--basedir", "--datadir",
                                                          "--python", "--silent", "--wait", "--port",
                                                          "--reload", "--spec"}
    assert {f for f in flags if f not in code} == set()                 # every documented option exists
    headings = {re.sub(r"[^\w\- ]", "", h.lower()).strip().replace(" ", "-")
                for h in re.findall(r"^#{1,4} (.+)$", text, re.M)}
    assert {a for a in re.findall(r"\]\(#([^)]+)\)", text) if a not in headings} == set()   # no dead links
    assert text.count("<details>") == text.count("</details>") and text.count("```") % 2 == 0
    for rel in re.findall(r"`((?:src|sql|cypher|api|web|tools|docker|docs|tests)/[\w./()\[\]-]+\.\w+)`", text):
        if "..." in rel:                       # placeholders like sql/07_...sql are examples, not files
            continue
        assert (ROOT / rel).exists(), f"README mentions missing file {rel}"
    for rel in re.findall(r"\]\(((?:docs|web|api|sql|src)/[^)#]+)\)", text):   # relative links
        assert (ROOT / rel).exists(), f"README links to missing file {rel}"
