/** Response shapes of the JSON API (the route handlers in app/api/). */

export type Row = Record<string, unknown>;
export type Role = "admin" | "faculty";
export type Day = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT";

export interface User {
  user_id: number;
  username: string;
  role: Role;
  faculty_id: number | null;
  faculty_name: string | null;
}

export interface Option<Id = number> {
  id: Id;
  label: string;
}

export interface Slot extends Option {
  day_of_week: Day;
  period_no: number;
  start_time: string;
  end_time: string;
}

export interface Meta {
  default_year: string;
  years: string[];
  days: Day[];
  sections: Option[];
  faculty: (Option & { name: string })[];
  rooms: Option[];
  courses: Option<string>[];
  slots: Slot[];
  neo4j: { ok: boolean; detail: string };
  counts: Record<string, number>;
}

export interface GridClass {
  course_id: string;
  course_type: string;
  lines: string[];
}

export interface GridRow {
  kind: "period" | "break";
  label: string;
  sub: string;
  cells: Record<string, GridClass[]>;
}

export interface Grid {
  days: string[];
  rows: GridRow[];
}

export interface TimetableRow {
  day_of_week: string;
  period_no: number;
  start_time: string;
  end_time: string;
  course_id: string;
  course_name: string;
  faculty_name: string;
  dept_name: string;
  semester: number;
  section_name: string;
  building: string;
  room_no: string;
}

export interface TimetableResponse {
  grid: Grid;
  rows: TimetableRow[];
  metrics: { periods: number; courses: number; days: number };
}

export interface FreeBlock {
  day_of_week: string;
  start_period: number;
  end_period: number;
  start_time: string;
  end_time: string;
  length: number;
}

export interface GenResult {
  status: "COMPLETE" | "PARTIAL" | "FAILED";
  academic_year: string;
  placed: number;
  required: number;
  complete: boolean;
  committed: boolean;
  nodes: number;
  attempts: number;
  elapsed: number;
  soft: { same_day_repeats: number; faculty_long_runs: number; lab_blocks_split: number } | Record<string, never>;
  preflight: string[];
  unplaced: Row[];
  error: string | null;
  note: string | null;
  report: string;
  max_fac_consec: number;
}

export interface EtlResult {
  ok: boolean;
  problems: string[];
  log: string[];
}

export type Fit = "QUALIFIED" | "RELATED";
export type CoverStatus = "COVERABLE" | "NEEDS_TEACHES" | "UNCOVERED";

export interface Candidate {
  candidate_id: number;
  candidate: string;
  fit: Fit;
  related_courses: string[];
}

export interface AbsentClass {
  timetable_id: number;
  day: string;
  period: number;
  start_time: string;
  course_id: string;
  course_name: string;
  section_id: number;
  section: string;
  room: string;
  students: number;
  status: CoverStatus;
  substitutes: Candidate[];
}

export interface AbsencePlan {
  classes: AbsentClass[];
  summary: {
    classes_affected: number;
    sections_affected: number;
    students_affected: number;
    coverable: number;
    needs_teaches_row: number;
    uncovered: number;
  };
  stale: string | null;
}

export interface Change {
  timetable_id: number;
  academic_year: string;
  course_id: string;
  section_id: number;
  slot_id: number;
  old_faculty_id: number;
  old_faculty: string;
  new_faculty_id: number;
  new_faculty: string;
  teaches_added: boolean;
}

export interface ChangeResult {
  change: Change;
  graph_problem: string | null;
}

export interface ClashReport {
  classes: number;
  clashes: Row[];
  gaps: Row[];
}

export interface RuleResult {
  rule: string;
  ok: boolean;
  hard: boolean;
  detail: string;
}

export interface CheckResult {
  accepted: boolean;
  hard_broken: number;
  results: RuleResult[];
}

export interface SectionClass {
  timetable_id: number;
  day_of_week: string;
  period_no: number;
  course_id: string;
  faculty: string;
}

export interface Ripple {
  moved: {
    moved_timetable_id: number;
    moved_course: string;
    moved_section: string;
    from_day: string;
    from_period: number;
    to_day: string;
    to_period: number;
  };
  clashes: {
    clash_course: string;
    clash_section: string;
    clash_faculty: string;
    clash_room: string;
    clash_types: string[];
    students_displaced: number;
  }[];
  free_move: boolean;
  students_displaced: number;
}

export interface Stats {
  classes: number;
  workload: { faculty_name: string; periods_per_week: number }[];
  rooms: { building: string; room_no: string; used_slots: number; total_slots?: number; utilization_pct: number }[];
  by_day: { day: string; classes: number }[];
  by_period: { period: number; classes: number }[];
  kinds: { type: string; classes: number }[];
  section_load: { section: string; day: string; n: number }[];
  departments: Row[];
  graph: { conflicted: { course_id: string; total_shared_count: number }[]; bridges: Row[] } | { error: string };
}

export interface GraphNode {
  id: string | number;
  name: string;
  properties: Row;
  degree: number;
}

export interface Neighbour {
  relationship: string;
  direction: "IN" | "OUT";
  label: string;
  key: string | number;
  name: string;
  properties: Row;
}

export interface Unavailability {
  faculty_id: number;
  faculty: string;
  slot_id: number;
  day: string;
  period: number;
  start_time: string;
  end_time: string;
  reason: string;
  updated_at: string;
}
