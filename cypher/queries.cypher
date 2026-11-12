// =====================================================================
// queries.cypher  --  documented analytic queries on the timetable graph
//
// This file is the SINGLE SOURCE OF TRUTH: lib/server/neo4j.ts parses the
// "// @query <name>" markers below and runs exactly these statements, so
// the documentation can never drift from the code.
//
// GRAPH MODEL (built by lib/server/etl.ts, npm run etl)
//   Nodes          Department, Faculty, Course, Section, Student, Classroom, TimeSlot
//   Relationships  (Faculty)-[:WORKS_IN]->(Department)
//                  (Faculty)-[:TEACHES]->(Course)            qualified to teach (Teaches table)
//                  (Student)-[:STUDIES_IN]->(Section)
//                  (Student)-[:ENROLLED_IN]->(Course)
//                  (Course)-[:OFFERED_BY]->(Department)
//                  (Course)-[:SCHEDULED_IN {timetable_id, academic_year, section_id,
//                       faculty_id, faculty_name, room_id, room_label, slot_id,
//                       day_of_week, day_no, period_no, start_time, end_time}]->(Section)
//                                                           one per Timetable row (= one period)
//                  (Course)-[:CONFLICTS_WITH {shared_faculty, shared_students, shared_count}]->(Course)
//                                                           derived; stored once per pair (a < b)
//                  extras: (Section)-[:BELONGS_TO]->(Department)
//                          (Section)-[:TAKES]->(Course)             from Section_Course
//                          (Faculty)-[:TEACHES_SECTION {academic_year, course_id, periods}]->(Section)
//                                                           derived from the timetable
//                  app:    (Faculty)-[:UNAVAILABLE_AT {reason, updated_at}]->(TimeSlot)
//                                                           written by the web app, not by the ETL
//                                                           (the ETL keeps it; --reset wipes it)
//
// Running in Neo4j Browser: set the parameters first, e.g.
//     :param faculty_id => 1
//     :param academic_year => '2026-2027'
//     :param day => null
// then paste one query. Everything is Cypher 5. All queries are read-only
// EXCEPT set_unavailability and delete_unavailability (the graph's create/
// update/delete of UNAVAILABLE_AT marks; lib/server/neo4j.ts runs those two
// in write transactions).
// =====================================================================


// @query impact_analysis
// Q1. IMPACT ANALYSIS: which scheduled classes are lost if a faculty member
//     is absent (all week, or only on $day)?
// Params: $faculty_id INT, $academic_year STRING, $day STRING or null ('MON'..'SAT')
// Returns one row per affected period with the number of students waiting.
MATCH (c:Course)-[s:SCHEDULED_IN]->(sec:Section)
WHERE s.faculty_id = $faculty_id
  AND s.academic_year = $academic_year
  AND ($day IS NULL OR s.day_of_week = $day)
WITH c, s, sec, size([(st:Student)-[:STUDIES_IN]->(sec) | st]) AS students
RETURN s.timetable_id AS timetable_id,
       s.day_of_week AS day,
       s.day_no AS day_no,
       s.period_no AS period,
       s.start_time AS start_time,
       c.course_id AS course_id,
       c.course_name AS course_name,
       sec.section_id AS section_id,
       sec.label AS section,
       s.room_label AS room,
       students
ORDER BY day_no, period;


// @query substitute_finder
// Q2. SUBSTITUTE FINDER: for every class of an absent faculty member, list
//     colleagues from the SAME DEPARTMENT who are FREE in that slot (no class
//     there and not marked UNAVAILABLE_AT it) and are
//     either
//       QUALIFIED = listed in Teaches for the very same course (can be
//                   assigned directly; the MySQL foreign key allows it), or
//       RELATED   = teach a course that CONFLICTS_WITH it (same students or
//                   faculty pool). Needs a Teaches row before assignment.
// Params: $faculty_id INT, $academic_year STRING, $day STRING or null
// Classes with no candidate at all are simply absent from the result; the
// TypeScript wrapper reports them as "no substitute".
MATCH (absent:Faculty {faculty_id: $faculty_id})-[:WORKS_IN]->(dept:Department)
MATCH (c:Course)-[s:SCHEDULED_IN]->(sec:Section)
WHERE s.faculty_id = absent.faculty_id
  AND s.academic_year = $academic_year
  AND ($day IS NULL OR s.day_of_week = $day)
MATCH (cand:Faculty)-[:WORKS_IN]->(dept)
WHERE cand.faculty_id <> absent.faculty_id
  AND NOT EXISTS { (cand)-[:UNAVAILABLE_AT]->(:TimeSlot {slot_id: s.slot_id}) }
OPTIONAL MATCH (cand)-[tq:TEACHES]->(c)
OPTIONAL MATCH (cand)-[:TEACHES]->(rc:Course)-[:CONFLICTS_WITH]-(c)
WITH c, s, sec, cand, tq, collect(DISTINCT rc.course_id) AS related_courses
OPTIONAL MATCH ()-[busy:SCHEDULED_IN]->()
WHERE busy.faculty_id = cand.faculty_id
  AND busy.slot_id = s.slot_id
  AND busy.academic_year = $academic_year
WITH c, s, sec, cand, tq, related_courses, count(busy) AS clashes
WHERE clashes = 0 AND (tq IS NOT NULL OR size(related_courses) > 0)
RETURN s.timetable_id AS timetable_id,
       s.day_of_week AS day,
       s.day_no AS day_no,
       s.period_no AS period,
       c.course_id AS course_id,
       sec.label AS section,
       cand.faculty_id AS candidate_id,
       cand.name AS candidate,
       CASE WHEN tq IS NOT NULL THEN 'QUALIFIED' ELSE 'RELATED' END AS fit,
       related_courses
// ('QUALIFIED' sorts before 'RELATED', so directly assignable candidates come first)
ORDER BY timetable_id, fit, candidate;


// @query most_conflicted_courses
// Q3. COURSES WITH THE MOST CONFLICTS: how many other courses each course
//     collides with, and how heavily (shared_count = shared qualified
//     faculty + shared enrolled students). Hard-to-schedule courses first.
// Params: $limit INT
MATCH (c:Course)-[:OFFERED_BY]->(d:Department)
OPTIONAL MATCH (c)-[r:CONFLICTS_WITH]-(o:Course)
WITH c, d, count(r) AS conflicting_courses, coalesce(sum(r.shared_count), 0) AS total_shared_count
RETURN c.course_id AS course_id,
       c.course_name AS course_name,
       d.dept_name AS department,
       conflicting_courses,
       total_shared_count
ORDER BY total_shared_count DESC, conflicting_courses DESC, course_id
LIMIT $limit;


// @query free_rooms
// Q4. FREE ROOMS FOR A SLOT, filtered by capacity and room type.
// Params: $day STRING ('MON'..'SAT'), $period INT (1..8), $min_capacity INT,
//         $room_type STRING ('LECTURE' | 'LAB') or null for any,
//         $academic_year STRING
// A room is free when no SCHEDULED_IN relationship uses it in that slot
// (OPTIONAL MATCH ... WHERE s IS NULL is the classic anti-join).
MATCH (t:TimeSlot {day_of_week: $day, period_no: $period})
MATCH (r:Classroom)
WHERE ($room_type IS NULL OR r.room_type = $room_type)
  AND r.capacity >= $min_capacity
OPTIONAL MATCH ()-[s:SCHEDULED_IN]->()
WHERE s.slot_id = t.slot_id
  AND s.room_id = r.room_id
  AND s.academic_year = $academic_year
WITH t, r, s
WHERE s IS NULL
RETURN r.room_id AS room_id,
       r.building AS building,
       r.room_no AS room_no,
       r.room_type AS room_type,
       r.capacity AS capacity
ORDER BY r.capacity, r.building, r.room_no;


// @query heaviest_day_students
// Q5. STUDENTS WITH THE HEAVIEST DAY: for each student, the day(s) with the
//     most periods (their enrolled courses as scheduled for their section).
//     Ties are reported as a list of days.
// Params: $academic_year STRING, $limit INT
MATCH (st:Student)-[:STUDIES_IN]->(sec:Section)
MATCH (st)-[:ENROLLED_IN]->(c:Course)-[s:SCHEDULED_IN]->(sec)
WHERE s.academic_year = $academic_year
WITH st, s.day_of_week AS day, count(s) AS periods
WITH st, max(periods) AS heaviest_periods, collect({day: day, periods: periods}) AS per_day
RETURN st.student_id AS student_id,
       st.name AS name,
       heaviest_periods AS periods,
       [d IN per_day WHERE d.periods = heaviest_periods | d.day] AS days
ORDER BY periods DESC, student_id
LIMIT $limit;


// @query faculty_shortest_path
// Q6. SHORTEST PATH BETWEEN TWO FACULTY through shared courses
//     (Faculty-TEACHES-Course-TEACHES-Faculty) or shared sections
//     (Faculty-TEACHES_SECTION-Section-TEACHES_SECTION-Faculty).
// Params: $from_id INT, $to_id INT (must differ). No rows = not connected.
MATCH (a:Faculty {faculty_id: $from_id}), (b:Faculty {faculty_id: $to_id})
MATCH p = shortestPath((a)-[:TEACHES|TEACHES_SECTION*..10]-(b))
RETURN [n IN nodes(p) | {kind: labels(n)[0], name: coalesce(n.name, n.course_id, n.label)}] AS path,
       length(p) AS hops;


// @query faculty_workload
// Q7. FACULTY WORKLOAD RANKING: periods per week, distinct teaching days,
//     courses and sections, busiest first. Faculty with no classes show 0.
// Params: $academic_year STRING
MATCH (f:Faculty)-[:WORKS_IN]->(d:Department)
OPTIONAL MATCH ()-[s:SCHEDULED_IN]->()
WHERE s.faculty_id = f.faculty_id
  AND s.academic_year = $academic_year
WITH f, d,
     count(s) AS periods,
     count(DISTINCT s.day_of_week) AS days,
     count(DISTINCT s.course_id) AS courses,
     count(DISTINCT s.section_id) AS sections
RETURN f.faculty_id AS faculty_id,
       f.name AS name,
       d.dept_name AS department,
       periods, days, courses, sections
ORDER BY periods DESC, name;


// @query move_class_ripple
// Q8. RIPPLE EFFECT OF MOVING ONE CLASS: if class $timetable_id is moved to
//     ($day, $period) keeping its faculty/section/room, which classes already
//     in that slot collide with it (same FACULTY, SECTION and/or ROOM), who
//     teaches them and how many students are displaced? Each returned class
//     would itself have to move: that is the ripple. No clash columns
//     (clash_timetable_id is null) = the move is free.
// Params: $timetable_id INT, $day STRING, $period INT
MATCH (c:Course)-[m:SCHEDULED_IN {timetable_id: $timetable_id}]->(sec:Section)
MATCH (t:TimeSlot {day_of_week: $day, period_no: $period})
OPTIONAL MATCH (c2:Course)-[x:SCHEDULED_IN]->(sec2:Section)
WHERE x.slot_id = t.slot_id
  AND x.academic_year = m.academic_year
  AND x.timetable_id <> m.timetable_id
  AND (x.faculty_id = m.faculty_id OR x.section_id = m.section_id OR x.room_id = m.room_id)
RETURN m.timetable_id AS moved_timetable_id,
       c.course_id AS moved_course,
       sec.label AS moved_section,
       m.day_of_week AS from_day,
       m.period_no AS from_period,
       t.day_of_week AS to_day,
       t.period_no AS to_period,
       x.timetable_id AS clash_timetable_id,
       c2.course_id AS clash_course,
       sec2.label AS clash_section,
       x.faculty_name AS clash_faculty,
       x.room_label AS clash_room,
       [k IN [CASE WHEN x.faculty_id = m.faculty_id THEN 'FACULTY' END,
              CASE WHEN x.section_id = m.section_id THEN 'SECTION' END,
              CASE WHEN x.room_id = m.room_id THEN 'ROOM' END] WHERE k IS NOT NULL] AS clash_types,
       size([(st:Student)-[:STUDIES_IN]->(sec2) | st]) AS students_displaced
ORDER BY clash_timetable_id;


// @query cross_department_teaching
// Q9. CROSS-DEPARTMENT TEACHING LINKS: faculty qualified for a course that
//     another department offers. These are the bridges that connect the
//     departments in the graph (and make Q6 paths between departments possible).
// Params: none
MATCH (f:Faculty)-[:WORKS_IN]->(fd:Department)
MATCH (f)-[:TEACHES]->(c:Course)-[:OFFERED_BY]->(cd:Department)
WHERE fd <> cd
RETURN f.faculty_id AS faculty_id,
       f.name AS name,
       fd.dept_name AS home_department,
       c.course_id AS course_id,
       cd.dept_name AS course_department
ORDER BY faculty_id, course_id;


// @query course_conflict_neighbours
// Q10. CONFLICT NEIGHBOURHOOD OF ONE COURSE: the courses that share faculty
//      or students with it, strongest first. Used when reasoning about
//      moving a course.
// Params: $course_id STRING
MATCH (c:Course {course_id: $course_id})-[r:CONFLICTS_WITH]-(o:Course)
RETURN o.course_id AS course_id,
       o.course_name AS course_name,
       r.shared_faculty AS shared_faculty,
       r.shared_students AS shared_students,
       r.shared_count AS shared_count
ORDER BY shared_count DESC, course_id;


// @query node_counts
// Q11. GRAPH SIZE: number of nodes per label (used to verify the ETL).
// Params: none
MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS nodes
ORDER BY label;


// @query relationship_counts
// Q12. GRAPH SIZE: number of relationships per type (used to verify the ETL).
// Params: none
MATCH ()-[r]->()
RETURN type(r) AS rel_type, count(*) AS relationships
ORDER BY rel_type;


// ---------------------------------------------------------------------
// GRAPH BROWSER AND FACULTY UNAVAILABILITY (read, create/update, delete)
// Used by the web app's Graph page. Key and display name per label:
//   Department dept_id / dept_name      Faculty   faculty_id / name
//   Course     course_id / course_name  Section   section_id / label
//   Student    student_id / name        Classroom room_id / building-room_no
//   TimeSlot   slot_id / 'MON P1'
// ---------------------------------------------------------------------

// @query node_browser
// Q13. NODE BROWSER (read): nodes of one label, optionally filtered by a
//      case-insensitive search on the key or display name, with their degree.
// Params: $label STRING (one of the 7 labels; validated in TypeScript),
//         $search STRING or null, $limit INT
MATCH (n)
WHERE $label IN labels(n)
WITH n, n[{Department: 'dept_id', Faculty: 'faculty_id', Course: 'course_id', Section: 'section_id',
           Student: 'student_id', Classroom: 'room_id', TimeSlot: 'slot_id'}[$label]] AS id,
     coalesce(n.name, n.dept_name, n.course_name, n.label,
              n.building + '-' + n.room_no, n.day_of_week + ' P' + toString(n.period_no)) AS name
WHERE $search IS NULL
   OR toLower(toString(id)) CONTAINS toLower($search)
   OR toLower(name) CONTAINS toLower($search)
RETURN id, name, properties(n) AS properties, size([(n)--() | 1]) AS degree
ORDER BY id
LIMIT $limit;


// @query node_neighbours
// Q14. NEIGHBOURS OF ONE NODE (read): every relationship of the node, its
//      type and direction (OUT = starts at this node) and the node at the other end.
// Params: $label STRING, $key INT (STRING for Course and Student), $limit INT
WITH {Department: 'dept_id', Faculty: 'faculty_id', Course: 'course_id', Section: 'section_id',
      Student: 'student_id', Classroom: 'room_id', TimeSlot: 'slot_id'} AS keys
MATCH (n)
WHERE $label IN labels(n) AND n[keys[$label]] = $key
MATCH (n)-[r]-(m)
WITH keys, n, r, m, labels(m)[0] AS label
RETURN type(r) AS relationship,
       CASE WHEN startNode(r) = n THEN 'OUT' ELSE 'IN' END AS direction,
       label,
       m[keys[label]] AS key,
       coalesce(m.name, m.dept_name, m.course_name, m.label,
                m.building + '-' + m.room_no, m.day_of_week + ' P' + toString(m.period_no)) AS name,
       properties(r) AS properties
ORDER BY relationship, label, name
LIMIT $limit;


// @query faculty_unavailability
// Q15. UNAVAILABILITY MARKS (read): slots a faculty member is marked
//      unavailable in (every faculty member when $faculty_id is null).
// Params: $faculty_id INT or null
MATCH (f:Faculty)-[u:UNAVAILABLE_AT]->(t:TimeSlot)
WHERE $faculty_id IS NULL OR f.faculty_id = $faculty_id
RETURN f.faculty_id AS faculty_id,
       f.name AS faculty,
       t.slot_id AS slot_id,
       t.day_of_week AS day,
       t.period_no AS period,
       t.start_time AS start_time,
       t.end_time AS end_time,
       u.reason AS reason,
       toString(u.updated_at) AS updated_at
ORDER BY faculty, t.day_no, period;


// @query set_unavailability
// Q16. MARK UNAVAILABLE (create or update; WRITE): MERGE creates the mark
//      once, running it again only changes the reason and the timestamp.
//      No row returned = unknown faculty or slot.
// Params: $faculty_id INT, $slot_id INT, $reason STRING
MATCH (f:Faculty {faculty_id: $faculty_id}), (t:TimeSlot {slot_id: $slot_id})
MERGE (f)-[u:UNAVAILABLE_AT]->(t)
SET u.reason = $reason, u.updated_at = datetime()
RETURN f.faculty_id AS faculty_id,
       f.name AS faculty,
       t.slot_id AS slot_id,
       t.day_of_week AS day,
       t.period_no AS period,
       t.start_time AS start_time,
       t.end_time AS end_time,
       u.reason AS reason,
       toString(u.updated_at) AS updated_at;


// @query delete_unavailability
// Q17. REMOVE A MARK (delete; WRITE). Returns how many marks were deleted (0 or 1).
// Params: $faculty_id INT, $slot_id INT
OPTIONAL MATCH (:Faculty {faculty_id: $faculty_id})-[u:UNAVAILABLE_AT]->(:TimeSlot {slot_id: $slot_id})
DELETE u
RETURN count(u) AS deleted;
