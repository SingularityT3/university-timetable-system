#!/bin/bash
# Runs ONCE, on the first start of the MySQL container (docker-entrypoint-initdb.d),
# after sql/06_auth_roles.sql has created the roles tt_admin and tt_faculty.
# Creates the two login accounts the API uses and gives each ONLY its role
# (no direct privileges). The API activates the role with SET ROLE after connecting.
# Credentials come from the container environment (docker-compose.yml).
set -e
ADMIN_USER="${MYSQL_ADMIN_USER:-tt_admin_app}"
FACULTY_USER="${MYSQL_FACULTY_USER:-tt_faculty_app}"
mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<SQL
CREATE USER IF NOT EXISTS '${ADMIN_USER}'@'%' IDENTIFIED BY '${MYSQL_ADMIN_PASSWORD:-change_me_admin_app}';
CREATE USER IF NOT EXISTS '${FACULTY_USER}'@'%' IDENTIFIED BY '${MYSQL_FACULTY_PASSWORD:-change_me_faculty_app}';
GRANT tt_admin TO '${ADMIN_USER}'@'%';
GRANT tt_faculty TO '${FACULTY_USER}'@'%';
FLUSH PRIVILEGES;
SQL
