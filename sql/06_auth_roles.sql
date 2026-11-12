-- =====================================================================
-- 06_auth_roles.sql  --  application logins (AppUser) and SQL roles
-- Run after 03_seed_data.sql (the faculty logins reference Faculty rows):
--     mysql -u root -p < sql/06_auth_roles.sql
-- Safe to re-run (IF NOT EXISTS / INSERT IGNORE; GRANT is idempotent).
--
--   AppUser     web-app accounts: PBKDF2 password hash, role admin|faculty;
--               a faculty login is tied to its Faculty row (CHECK).
--   tt_admin    SQL role: read + write the whole schema, run routines
--   tt_faculty  SQL role: read-only, and NOT allowed to read AppUser
--
-- The login accounts that hold these roles are created by
-- docker/mysql/07_role_accounts.sh (passwords come from the environment).
-- The API runs every request on the account matching the logged-in user and
-- activates the role with SET ROLE, so a faculty request cannot write even if
-- the application had a bug. AppUser itself is read by the service account
-- (MYSQL_USER) at login time.
--
-- Demo logins (passwords hashed with `npm run hash-password -- <password>`):
--     admin    / admin123     admin
--     faculty1 / faculty123   faculty, faculty_id 1  (CSE)
--     faculty2 / faculty123   faculty, faculty_id 11 (ECE)
-- =====================================================================

USE university_timetable;

-- faculty_id uses the default FK action (RESTRICT): MySQL does not allow a
-- column that has an ON DELETE SET NULL / CASCADE action inside a CHECK
-- constraint, and SET NULL would break the CHECK anyway. Deactivate or
-- delete the login before deleting its Faculty row.
CREATE TABLE IF NOT EXISTS AppUser (
    user_id       INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('admin', 'faculty') NOT NULL,
    faculty_id    INT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login    TIMESTAMP NULL,
    CONSTRAINT fk_appuser_faculty
        FOREIGN KEY (faculty_id) REFERENCES Faculty(faculty_id),
    CONSTRAINT chk_appuser_faculty_link
        CHECK (role = 'admin' OR faculty_id IS NOT NULL)
);

INSERT IGNORE INTO AppUser (username, password_hash, role, faculty_id) VALUES
('admin',    'pbkdf2_sha256$200000$ZUPiYJa0X-GT2dnXgvyigQ$EgO8fGsrZGDgYiLJgIaQV6tMFUdycimb54-ez_rPhTI', 'admin',   NULL),
('faculty1', 'pbkdf2_sha256$200000$meDKhI0t2MXO7RvE1yGbzQ$_MPN_u_HkvWRBPvVlg0aFjFkYj_S8DOZ2DLxzvc_ToM', 'faculty', 1),
('faculty2', 'pbkdf2_sha256$200000$s2U0Ytqu1gmy4WLz62ZJcA$vf08P8lFAQXIYOOcUeq7AcEXB7OAgmIBw1axpHpZHGg', 'faculty', 11);

-- ---------------------------------------------------------------------
-- SQL roles (one statement each: MariaDB creates one role per statement)
-- ---------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS tt_admin;
CREATE ROLE IF NOT EXISTS tt_faculty;

-- Admin: full data access (no DDL) and every stored routine.
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON university_timetable.* TO tt_admin;

-- Faculty: SELECT table by table (everything except AppUser), plus routines.
-- No INSERT / UPDATE / DELETE anywhere.
GRANT SELECT ON university_timetable.Department          TO tt_faculty;
GRANT SELECT ON university_timetable.Faculty             TO tt_faculty;
GRANT SELECT ON university_timetable.Course              TO tt_faculty;
GRANT SELECT ON university_timetable.Classroom           TO tt_faculty;
GRANT SELECT ON university_timetable.Section             TO tt_faculty;
GRANT SELECT ON university_timetable.Student             TO tt_faculty;
GRANT SELECT ON university_timetable.TimeSlot            TO tt_faculty;
GRANT SELECT ON university_timetable.Teaches             TO tt_faculty;
GRANT SELECT ON university_timetable.Enrollment          TO tt_faculty;
GRANT SELECT ON university_timetable.Timetable           TO tt_faculty;
GRANT SELECT ON university_timetable.Section_Course      TO tt_faculty;
GRANT SELECT ON university_timetable.v_section_timetable TO tt_faculty;
GRANT SELECT ON university_timetable.v_faculty_timetable TO tt_faculty;
GRANT SELECT ON university_timetable.v_room_utilization  TO tt_faculty;
GRANT SELECT ON university_timetable.v_free_slots        TO tt_faculty;
GRANT EXECUTE ON university_timetable.* TO tt_faculty;
