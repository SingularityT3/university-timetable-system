/**
 * Writes sql/03_seed_data.sql (plain INSERT statements).
 *
 * Optional helper: the generated SQL file is already provided. Re-run it only to tweak the data:
 *     npm run make-seed [-- <output file>]
 * Output is deterministic: the student-name shuffle uses a Mersenne Twister (MT19937, seed 42) with the
 * same seeding and shuffle algorithm as CPython's random module, so the file has never changed since the
 * project's original Python seed script.
 *
 * Sizing: 3 departments, 20 faculty, 30 courses (24 THEORY + 6 LAB), 10 sections,
 * 120 students, 25 rooms (18 LECTURE + 7 LAB), 48 time slots (6 days x 8).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Value = string | number | null;

// ------------------------------------------------- deterministic random (MT19937)
/** MT19937 seeded like CPython's random.seed(int) (init_by_array with the 32-bit words of the seed). */
function mt19937(seed: number) {
  const mt = new Uint32Array(624);
  let mti = 624;
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++) mt[i] = Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i;
  const key = [seed >>> 0]; // seeds < 2**32 are a single word
  let i = 1, j = 0;
  for (let k = Math.max(624, key.length); k; k--) {
    mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j;
    i++; j++;
    if (i >= 624) { mt[0] = mt[623]; i = 1; }
    if (j >= key.length) j = 0;
  }
  for (let k = 623; k; k--) {
    mt[i] = (mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i;
    i++;
    if (i >= 624) { mt[0] = mt[623]; i = 1; }
  }
  mt[0] = 0x80000000;

  function uint32(): number {
    if (mti >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      mti = 0;
    }
    let y = mt[mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    return (y ^ (y >>> 18)) >>> 0;
  }
  /** random.randbelow(n) for n < 2**31: rejection sampling on getrandbits(n.bit_length()). */
  function below(n: number): number {
    const k = n.toString(2).length;
    let r: number;
    do r = uint32() >>> (32 - k); while (r >= n);
    return r;
  }
  /** random.shuffle (Fisher-Yates from the end). */
  function shuffle<T>(x: T[]): void {
    for (let a = x.length - 1; a > 0; a--) {
      const b = below(a + 1);
      [x[a], x[b]] = [x[b], x[a]];
    }
  }
  return { shuffle };
}

/** SQL literal: numbers raw, strings quoted with '' escaping. */
const q = (v: Value): string => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

function insert(table: string, cols: string[], rows: Value[][]): string {
  const body = rows.map((r) => `  (${r.map(q).join(", ")})`).join(",\n");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n${body};\n`;
}

// ---------------------------------------------------------------- departments
const DEPTS: Value[][] = [
  [1, "Computer Science and Engineering", "Block A"],
  [2, "Electronics and Communication Engineering", "Block B"],
  [3, "Mechanical Engineering", "Block C"],
];
const DEPT_CODE: Record<number, string> = { 1: "CS", 2: "EC", 3: "ME" };

// ------------------------------------------------------------------- faculty
// ids are explicit so Teaches below can reference them deterministically
const FACULTY_BY_DEPT: [number, string[]][] = [
  [1, ["Dr. Meenakshi Sundaram", "Dr. Arvind Krishnan", "Prof. Lakshmi Narayanan", "Dr. Priya Venkatesh",
    "Prof. Rajesh Iyer", "Dr. Kavitha Subramanian", "Prof. Suresh Babu", "Dr. Anjali Menon",
    "Prof. Karthik Raman", "Dr. Divya Chandran"]], // ids 1-10
  [2, ["Dr. Ramesh Pillai", "Prof. Sangeetha Gopal", "Dr. Vikram Nair", "Prof. Deepa Murali",
    "Dr. Harish Kumar", "Prof. Nirmala Devi"]], // 11-16
  [3, ["Dr. Balaji Srinivasan", "Prof. Gayathri Ramesh", "Dr. Mohan Rajan", "Prof. Sunitha Das"]], // 17-20
];
const FACULTY: Value[][] = FACULTY_BY_DEPT.flatMap(([dept, names]) => names.map((n) => [dept, n] as const))
  .map(([dept, n], i) => {
    const plain = n.replace("Dr. ", "").replace("Prof. ", "");
    return [i + 1, n, plain.toLowerCase().replace(/ /g, ".") + "@university.edu", dept];
  });

// ------------------------------------------------------------------- courses
// (id, name, credits, weekly_hours, type, dept_id)
const [T, L] = ["THEORY", "LAB"];
const COURSES: [string, string, number, number, string, number][] = [
  // CSE semester 3
  ["CS201", "Data Structures", 4, 4, T, 1],
  ["CS202", "Digital Logic Design", 3, 3, T, 1],
  ["CS203", "Discrete Mathematics", 3, 3, T, 1],
  ["CS204", "Object Oriented Programming", 3, 3, T, 1],
  ["CS205L", "Data Structures Lab", 1, 2, L, 1],
  // CSE semester 5
  ["CS301", "Database Management Systems", 4, 4, T, 1],
  ["CS302", "Operating Systems", 4, 4, T, 1],
  ["CS303", "Computer Networks", 3, 3, T, 1],
  ["CS304", "Theory of Computation", 3, 3, T, 1],
  ["CS305L", "DBMS Lab", 1, 2, L, 1],
  // ECE semester 3
  ["EC201", "Network Analysis", 4, 4, T, 2],
  ["EC202", "Electronic Devices", 3, 3, T, 2],
  ["EC203", "Signals and Systems", 3, 3, T, 2],
  ["EC204", "Digital Electronics", 3, 3, T, 2],
  ["EC205L", "Electronics Lab", 1, 2, L, 2],
  // ECE semester 5
  ["EC301", "Analog Circuits", 4, 4, T, 2],
  ["EC302", "Digital Signal Processing", 4, 4, T, 2],
  ["EC303", "Microprocessors", 3, 3, T, 2],
  ["EC304", "Communication Systems", 3, 3, T, 2],
  ["EC305L", "DSP Lab", 1, 2, L, 2],
  // MECH semester 3
  ["ME201", "Thermodynamics", 4, 4, T, 3],
  ["ME202", "Fluid Mechanics", 3, 3, T, 3],
  ["ME203", "Strength of Materials", 3, 3, T, 3],
  ["ME204", "Manufacturing Processes", 3, 3, T, 3],
  ["ME205L", "Workshop Lab", 1, 2, L, 3],
  // MECH semester 5
  ["ME301", "Heat Transfer", 4, 4, T, 3],
  ["ME302", "Machine Design", 4, 4, T, 3],
  ["ME303", "Dynamics of Machinery", 3, 3, T, 3],
  ["ME304", "Metrology and Measurements", 3, 3, T, 3],
  ["ME305L", "Thermal Engineering Lab", 1, 2, L, 3],
];
// Courses of each (dept, semester) = the plan every section of it follows ('2xx' -> semester 3, '3xx' -> 5)
const PLAN = new Map<string, string[]>();
for (const c of COURSES) {
  const key = `${c[5]}|${c[0][2] === "2" ? 3 : 5}`;
  PLAN.set(key, [...(PLAN.get(key) ?? []), c[0]]);
}

// ------------------------------------------------------------------ teaches
// Each course has 2 qualified faculty; two cross-department rows (F7 -> EC303, F13 -> CS202)
// give the graph some inter-department links.
const TEACHES: Record<string, number[]> = {
  CS201: [1, 2], CS202: [3, 9, 13], CS203: [3, 4], CS204: [2, 4],
  CS205L: [1, 10], CS301: [5, 6], CS302: [6, 7], CS303: [7, 8],
  CS304: [8, 9], CS305L: [5, 10],
  EC201: [11, 12], EC202: [11, 13], EC203: [12, 13], EC204: [12, 13],
  EC205L: [11, 16], EC301: [14, 15], EC302: [14, 16],
  EC303: [15, 16, 7], EC304: [15, 16], EC305L: [14, 15],
  ME201: [17, 18], ME202: [17, 19], ME203: [18, 20], ME204: [19, 20],
  ME205L: [17, 20], ME301: [18, 19], ME302: [17, 18],
  ME303: [19, 20], ME304: [18, 19], ME305L: [17, 20],
};

// ------------------------------------------------------------------ sections
// (id, name, semester, strength, dept_id). Odd semesters (Aug-Dec term); strength = declared class size.
const SECTIONS: [number, string, number, number, number][] = [
  [1, "A", 3, 60, 1], [2, "B", 3, 60, 1], [3, "C", 3, 55, 1],
  [4, "A", 5, 60, 1], [5, "B", 5, 50, 1],
  [6, "A", 3, 60, 2], [7, "B", 3, 58, 2], [8, "A", 5, 50, 2],
  [9, "A", 3, 60, 3], [10, "A", 5, 45, 3],
];

// ------------------------------------------------------------------ classrooms
const zip = <A, B>(a: A[], b: B[]): [A, B][] => a.map((x, i) => [x, b[i]]);
const ROOMS: Value[][] = [
  ...zip(["101", "102", "103", "104", "105", "106", "201", "202", "203", "204", "205", "206"],
    [60, 60, 60, 70, 70, 70, 60, 60, 65, 65, 70, 70]).map(([no, cap]) => [no, "Main Block", cap, "LECTURE"]),
  ...zip(["N101", "N102", "N103", "N104", "N201", "N202"], [40, 40, 50, 50, 100, 100])
    .map(([no, cap]) => [no, "Annex", cap, "LECTURE"]),
  ...zip(["L101", "L102", "L103", "L104", "L201", "L202", "L203"], [60, 60, 64, 64, 70, 70, 60])
    .map(([no, cap]) => [no, "Lab Complex", cap, "LAB"]),
].map((r, i) => [i + 1, ...r]);

// ------------------------------------------------------------------ time slots
// 8 periods with a tea break after P2, lunch after P4, break after P6. "Consecutive" lab periods
// must not straddle lunch (P4 -> P5); P2->P3 and P6->P7 are short breaks and acceptable.
const PERIODS = [["08:30", "09:20"], ["09:20", "10:10"], ["10:25", "11:15"], ["11:15", "12:05"],
  ["13:00", "13:50"], ["13:50", "14:40"], ["14:55", "15:45"], ["15:45", "16:35"]];
const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];
const SLOTS: Value[][] = DAYS.flatMap((day, d) => PERIODS.map(([s, e], p) => [d * 8 + p + 1, day, p + 1, s + ":00", e + ":00"]));

// ------------------------------------------------------------------ students
const FIRST = ["Aarav", "Aditi", "Akash", "Ananya", "Arjun", "Bhavana", "Chaitra", "Deepak", "Divya", "Eshwar",
  "Gokul", "Harini", "Ishaan", "Janani", "Karan", "Keerthana", "Lavanya", "Madhan", "Nandini", "Naveen",
  "Pooja", "Pranav", "Rahul", "Revathi", "Rohan", "Sanjana", "Shreya", "Siddharth", "Sneha", "Tarun",
  "Uma", "Varun", "Vidya", "Vishal", "Yamini", "Yuvan", "Zoya", "Ashwin", "Meera", "Nikhil"];
const LAST = ["Agarwal", "Balasubramanian", "Chopra", "Dutta", "Gupta", "Hegde", "Iyengar", "Joshi",
  "Krishnamurthy", "Kulkarni", "Mehta", "Mukherjee", "Nambiar", "Patel", "Prasad", "Rao", "Reddy", "Sharma",
  "Shetty", "Singh", "Thomas", "Varma", "Venkatesan", "Yadav"];
const combos = FIRST.flatMap((first) => LAST.map((last) => `${first} ${last}`));
mt19937(42).shuffle(combos);
const STUDENTS_PER_SECTION = 12;
const STUDENTS: [string, string, string, number][] = [];
for (const [sid, sname, sem, , dept] of SECTIONS) {
  const admYear = sem === 3 ? 25 : 24; // admission year of the batch
  for (let n = 1; n <= STUDENTS_PER_SECTION; n++) {
    const id = `UG${admYear}${DEPT_CODE[dept]}${sem}${sname}${String(n).padStart(2, "0")}`;
    STUDENTS.push([id, combos[STUDENTS.length], id.toLowerCase() + "@student.university.edu", sid]);
  }
}

// ------------------------------------------------- section plans + enrollment
const SECTION_COURSE: [number, string, number][] = SECTIONS.flatMap(([sid, , sem, , dept]) =>
  PLAN.get(`${dept}|${sem}`)!.map((cid): [number, string, number] => [sid, cid, sem]));
const ENROLLMENT: Value[][] = STUDENTS.flatMap(([stu, , , sid]) =>
  SECTION_COURSE.filter(([s]) => s === sid).map(([, cid]) => [stu, cid])); // student takes the section plan
const TEACHES_ROWS: Value[][] = Object.entries(TEACHES).flatMap(([c, fs]) => fs.map((f) => [f, c]));

// --------------------------------------------------------------------- output
const HEADER = `-- =====================================================================
-- 03_seed_data.sql  --  generated by scripts/make-seed.ts (deterministic)
-- Run after 02_migration_improvements.sql:
--     mysql -u root -p < sql/03_seed_data.sql
-- Re-runnable: it empties the tables first (including Timetable!) and
-- ids are explicit, so the Neo4j ETL and tests can rely on them.
-- Timetable is NOT seeded here; the generator (npm run generate) fills it.
--
-- Sizes: 3 departments | 20 faculty | 30 courses (24 THEORY, 6 LAB)
--        10 sections | 120 students | 25 rooms (18 LECTURE, 7 LAB)
--        48 time slots (MON-SAT x 8 periods) | 62 Teaches rows
--        50 Section_Course rows | 600 Enrollment rows
-- Feasibility: every section needs 15-16 periods/week out of 48 slots,
-- every course has 2 qualified faculty, and 154 section-periods compete
-- for 25 rooms x 48 slots. Section strengths (<= 60) fit the rooms.
-- Students (12 per section) are a sample; Section.strength is the
-- declared class size that the capacity check uses.
-- =====================================================================
USE university_timetable;

SET FOREIGN_KEY_CHECKS = 0;
${["Timetable", "Enrollment", "Section_Course", "Teaches", "Student", "Section", "TimeSlot", "Classroom", "Course",
  "Faculty", "Department"].map((t) => `TRUNCATE TABLE ${t};\n`).join("")}SET FOREIGN_KEY_CHECKS = 1;
`;

const out = [
  HEADER,
  "-- Departments\n" + insert("Department", ["dept_id", "dept_name", "building"], DEPTS),
  "-- Faculty\n" + insert("Faculty", ["faculty_id", "name", "email", "dept_id"], FACULTY),
  "-- Courses\n" + insert("Course", ["course_id", "course_name", "credits", "weekly_hours", "course_type", "dept_id"], COURSES),
  "-- Classrooms\n" + insert("Classroom", ["room_id", "room_no", "building", "capacity", "room_type"], ROOMS),
  "-- Sections\n" + insert("Section", ["section_id", "section_name", "semester", "strength", "dept_id"], SECTIONS),
  "-- Students\n" + insert("Student", ["student_id", "name", "email", "section_id"], STUDENTS),
  "-- Time slots\n" + insert("TimeSlot", ["slot_id", "day_of_week", "period_no", "start_time", "end_time"], SLOTS),
  "-- Teaches (faculty qualified for each course)\n" + insert("Teaches", ["faculty_id", "course_id"], TEACHES_ROWS),
  "-- Section_Course (what each section must take)\n" +
    insert("Section_Course", ["section_id", "course_id", "semester"], SECTION_COURSE),
  "-- Enrollment (each student takes their section's plan)\n" + insert("Enrollment", ["student_id", "course_id"], ENROLLMENT),
];

const target = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "sql", "03_seed_data.sql"));
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, out.join("\n"), "utf-8");
console.log(`wrote ${target}: ${FACULTY.length} faculty, ${COURSES.length} courses, ${SECTIONS.length} sections, ` +
  `${STUDENTS.length} students, ${ROOMS.length} rooms, ${SLOTS.length} slots, ${TEACHES_ROWS.length} teaches, ` +
  `${SECTION_COURSE.length} section_course, ${ENROLLMENT.length} enrollment`);
