-- =====================================================================
-- 05_advanced_sql.sql  --  stored FUNCTION, CTEs and a RECURSIVE CTE
-- Run after 04_views_procedures.sql (uses DELIMITER: load it with the CLI):
--     mysql -u root -p < sql/05_advanced_sql.sql
-- Works on MySQL 8.0+ and MariaDB 10.2+ (CTEs and window functions).
--
--   fn_faculty_load        STORED FUNCTION   periods per week of one teacher
--   sp_department_summary  NON-RECURSIVE CTEs (WITH a, b, c ...) that call
--                          the function, plus a window function (ROW_NUMBER)
--                          to pick each department's busiest teacher
--   sp_free_blocks         RECURSIVE CTE (WITH RECURSIVE): maximal runs of
--                          consecutive free periods of a faculty member or room
-- =====================================================================

USE university_timetable;

DELIMITER $$

-- ---------------------------------------------------------------------
-- STORED FUNCTION: periods per week taught by one faculty member in one
-- academic year (= his/her rows in Timetable). Used by the CTE below.
--     SELECT fn_faculty_load(1, '2026-2027');
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_faculty_load$$
CREATE FUNCTION fn_faculty_load(p_faculty_id INT, p_year VARCHAR(9)) RETURNS INT
    READS SQL DATA
BEGIN
    DECLARE v_periods INT;
    SELECT COUNT(*) INTO v_periods
      FROM Timetable
     WHERE faculty_id = p_faculty_id AND academic_year = p_year;
    RETURN v_periods;
END$$

-- ---------------------------------------------------------------------
-- CTE (non-recursive): one summary row per department.
--   loads    every faculty member with fn_faculty_load()
--   ranked   ROW_NUMBER() per department, busiest teacher first
--   staff    faculty count, teaching faculty, total periods, average load
--   classes  the department's sections and the classes scheduled for them
--     CALL sp_department_summary('2026-2027');
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_department_summary$$
CREATE PROCEDURE sp_department_summary(IN p_year VARCHAR(9))
BEGIN
    WITH loads AS (
        SELECT f.faculty_id, f.name, f.dept_id,
               fn_faculty_load(f.faculty_id, p_year) AS periods
        FROM Faculty f
    ),
    ranked AS (
        SELECT l.*,
               ROW_NUMBER() OVER (PARTITION BY l.dept_id ORDER BY l.periods DESC, l.name) AS rn
        FROM loads l
    ),
    staff AS (
        SELECT dept_id,
               COUNT(*)                                AS faculty_count,
               COUNT(CASE WHEN periods > 0 THEN 1 END) AS teaching_faculty,
               CAST(SUM(periods) AS SIGNED)            AS total_periods,
               ROUND(AVG(periods), 2)                  AS avg_load
        FROM loads
        GROUP BY dept_id
    ),
    classes AS (
        SELECT s.dept_id,
               COUNT(DISTINCT s.section_id) AS sections,
               COUNT(t.timetable_id)        AS classes_scheduled
        FROM Section s
        LEFT JOIN Timetable t
               ON t.section_id = s.section_id AND t.academic_year = p_year
        GROUP BY s.dept_id
    )
    SELECT d.dept_id,
           d.dept_name,
           COALESCE(st.faculty_count, 0)     AS faculty_count,
           COALESCE(st.teaching_faculty, 0)  AS teaching_faculty,
           COALESCE(st.total_periods, 0)     AS total_periods,
           COALESCE(st.avg_load, 0)          AS avg_load,
           b.name                            AS busiest_faculty,
           b.periods                         AS busiest_load,
           COALESCE(c.sections, 0)           AS sections,
           COALESCE(c.classes_scheduled, 0)  AS classes_scheduled
    FROM Department d
    LEFT JOIN staff   st ON st.dept_id = d.dept_id
    LEFT JOIN ranked  b  ON b.dept_id  = d.dept_id AND b.rn = 1 AND b.periods > 0
    LEFT JOIN classes c  ON c.dept_id  = d.dept_id
    ORDER BY d.dept_name;
END$$

-- ---------------------------------------------------------------------
-- RECURSIVE CTE: free blocks of a FACULTY member or a ROOM.
-- A block is a maximal run of consecutive FREE periods on one day.
-- "Consecutive" = same day, next period_no and a gap of less than 30
-- minutes (same rule as utils.build_slot_links): tea breaks keep a run
-- going, lunch ends it.
--   free   slots with no Timetable row for that resource
--   link   free slot -> the free slot directly after it
--   run    ANCHOR: free slots with no free predecessor (a block starts)
--          RECURSIVE STEP: extend the run by the next linked free slot
-- A run is maximal when its last slot has no successor.
--     CALL sp_free_blocks('2026-2027', 'FACULTY', 1);
--     CALL sp_free_blocks('2026-2027', 'ROOM', 3);
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_free_blocks$$
CREATE PROCEDURE sp_free_blocks(IN p_year VARCHAR(9), IN p_kind VARCHAR(10), IN p_id INT)
BEGIN
    IF p_kind NOT IN ('FACULTY', 'ROOM') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_kind must be FACULTY or ROOM';
    END IF;

    WITH RECURSIVE
    free AS (
        SELECT ts.slot_id, ts.day_of_week, ts.period_no, ts.start_time, ts.end_time
        FROM TimeSlot ts
        WHERE NOT EXISTS (
            SELECT 1 FROM Timetable t
            WHERE t.academic_year = p_year
              AND t.slot_id = ts.slot_id
              AND ((p_kind = 'FACULTY' AND t.faculty_id = p_id)
                OR (p_kind = 'ROOM'    AND t.room_id    = p_id)))
    ),
    link AS (
        SELECT a.slot_id AS from_slot, b.slot_id AS to_slot
        FROM free a
        JOIN free b
          ON b.day_of_week = a.day_of_week
         AND b.period_no   = a.period_no + 1
         AND TIME_TO_SEC(b.start_time) - TIME_TO_SEC(a.end_time) < 30 * 60
    ),
    run AS (
        SELECT f.slot_id AS last_slot, f.day_of_week,
               f.period_no AS start_period, f.period_no AS end_period,
               f.start_time, f.end_time, 1 AS length
        FROM free f
        WHERE NOT EXISTS (SELECT 1 FROM link l WHERE l.to_slot = f.slot_id)
        UNION ALL
        SELECT n.slot_id, r.day_of_week,
               r.start_period, n.period_no,
               r.start_time, n.end_time, r.length + 1
        FROM run r
        JOIN link l ON l.from_slot = r.last_slot
        JOIN free n ON n.slot_id = l.to_slot
    )
    SELECT r.day_of_week, r.start_period, r.end_period, r.start_time, r.end_time, r.length
    FROM run r
    WHERE NOT EXISTS (SELECT 1 FROM link l WHERE l.from_slot = r.last_slot)
    ORDER BY FIELD(r.day_of_week, 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'), r.start_period;
END$$

DELIMITER ;
