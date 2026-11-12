/**
 * Clash-free timetable generator: reads MySQL, writes Timetable.
 *
 * ALGORITHM
 * 1. LOAD slots, sections, the Section_Course plan, Teaches, rooms and the course CONFLICT GRAPH
 *    (utils.buildConflictGraph: courses sharing qualified faculty or enrolled students, weighted).
 * 2. PRE-FLIGHT: cheap necessary-condition checks that explain impossible inputs at once
 *    (course nobody teaches, no room big enough, a faculty pool that cannot cover the hours ...).
 * 3. TASKS: every (section, course) needs weekly_hours periods. THEORY -> one task per period,
 *    LAB -> blocks of up to 3 consecutive periods (one task per block).
 * 4. ORDER BY DIFFICULTY ("most constrained first", as in graph colouring): lab blocks first, then
 *    fewer qualified faculty, fewer eligible rooms, higher conflict-graph degree, more weekly hours.
 * 5. BACKTRACKING SEARCH (iterative DFS, explicit stack). For each task every placement (faculty,
 *    room, slot window) satisfying the HARD constraints is enumerated:
 *      - section / faculty / room not already used in any of those slots
 *      - faculty in Teaches for the course
 *      - room type matches (LAB<->LAB, THEORY<->LECTURE), capacity >= strength
 *    and sorted by a SOFT-constraint penalty (lower first):
 *      - same course twice on one day (section)            +100 per repeat
 *      - faculty teaching more than 3 consecutive periods  +80 per extra
 *      - lab block split into non-consecutive periods      +1000 (fallback)
 *      - uneven daily load of section / faculty, Saturday  small weights
 *    The cheapest candidate is placed; a task without candidates makes the search undo and try the
 *    next candidate one level up (chronological backtracking). Budget: node and time limits, with
 *    a few randomised restarts (shuffled tie-breaks).
 * 6. FAILURE HANDLING: no complete timetable -> a greedy pass places what it can and diagnoses every
 *    task it cannot place. Nothing is written unless allowPartial.
 * 7. SAVE in ONE TRANSACTION (delete the year's rows, insert the new ones). MySQL errors (1062, 1452,
 *    trigger rules 5001-5003) are translated to plain English and everything is rolled back.
 *
 * CLI: npm run generate -- --year 2026-2027 --replace   (scripts/generate.ts)
 */
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import { pool, query, transaction, type Db, type Row } from "./db";
import { academicYear } from "./env";
import { buildConflictGraph, buildSlotLinks, describeMysqlError } from "./utils";

// ----------------------------------------------------------------- tunables
export const MAX_LAB_BLOCK = 3; // longest run of consecutive lab periods in one block
export const MAX_FAC_CONSEC = 3; // soft: faculty should not teach more than this in a row
const LONG_BREAK_MIN = 30; // a gap >= this (lunch) breaks "consecutive"
const K_ROOMS = 2; // rooms tried per (faculty, window): best fit first

const W_SAME_DAY = 100; // same course again on a day the section already has it
const W_FAC_RUN = 80; // per period beyond MAX_FAC_CONSEC in a row
const W_SCATTER = 1000; // lab hours not in one consecutive block
const W_SEC_BALANCE = 4; // per class the section already has that day
const W_FAC_BALANCE = 3; // per class the faculty already has that day
const W_SATURDAY = 5; // mild preference for Mon-Fri

// --------------------------------------------------------------- data types
export interface GenerateOptions {
  academicYear?: string; // default academicYear()
  replace?: boolean;
  allowPartial?: boolean;
  dryRun?: boolean;
  timeLimit?: number; // seconds, default 30
  maxNodes?: number; // default 300_000
  restarts?: number; // default 4
  seed?: number; // default 42
  conn?: PoolConnection; // default: a service-account connection
}

export type TimetableRow = [string, number, number, number, number, string]; // course, faculty, room, slot, section, year
export interface Soft { same_day_repeats: number; faculty_long_runs: number; lab_blocks_split: number }
export interface Unplaced { section: number; course: string; periods: number; reason: string }

export interface GenerationResult {
  academic_year: string;
  required: number; // periods that must be placed
  placed: number; // periods actually placed
  complete: boolean;
  committed: boolean;
  rows: TimetableRow[];
  unplaced: Unplaced[];
  preflight: string[]; // blocking input problems
  soft: Soft | Record<string, never>;
  nodes: number;
  attempts: number;
  elapsed: number; // seconds
  error: string | null;
  note: string | null;
}

export interface CheckResult { rule: string; ok: boolean; hard: boolean; detail: string }

export interface SubstitutionChange {
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

/** A class cannot be reassigned (carries a plain-English reason). */
export class SubstitutionError extends Error {
  name = "SubstitutionError";
}
/** Saving failed (carries a plain-English reason). */
export class GenerationError extends Error {
  name = "GenerationError";
}

/** One schedulable unit: blockSize periods of a course for a section. */
export interface Task { sectionId: number; courseId: string; blockSize: number; seq: number; courseType: string }

export interface Placement { task: Task; facultyId: number; roomId: number; slots: number[]; penalty: number }

export function resultStatus(r: GenerationResult): "COMPLETE" | "PARTIAL" | "FAILED" {
  return r.complete ? "COMPLETE" : r.placed ? "PARTIAL" : "FAILED";
}

export function isSuccess(r: GenerationResult): boolean {
  return r.complete && r.error === null;
}

/** Plain-text report of a generation run (CLI output and the API's `report`). */
export function report(r: GenerationResult): string {
  const lines = [
    `Academic year : ${r.academic_year}`,
    `Result        : ${resultStatus(r)}`,
    `Periods placed: ${r.placed} / ${r.required}   (search: ${r.attempts} attempt(s), ${r.nodes} nodes, ${r.elapsed.toFixed(2)}s)`,
  ];
  if ("same_day_repeats" in r.soft) {
    lines.push("Soft constraints (best effort):",
      `  - same course twice on one day : ${r.soft.same_day_repeats}`,
      `  - faculty runs > ${MAX_FAC_CONSEC} consecutive   : ${r.soft.faculty_long_runs}`,
      `  - lab blocks not consecutive   : ${r.soft.lab_blocks_split}`);
  }
  if (r.preflight.length) lines.push("Input problems (nothing was searched):", ...r.preflight.map((p) => `  ! ${p}`));
  if (r.unplaced.length) {
    lines.push("Could NOT be placed:",
      ...r.unplaced.map((u) => `  ! section ${u.section} / ${u.course} (${u.periods} period(s)): ${u.reason}`));
  }
  lines.push("Saved to MySQL: " + (r.committed ? `yes (${r.rows.length} rows)` : "no" + (r.note ? ` -- ${r.note}` : "")));
  if (r.error) lines.push(`Error         : ${r.error}`);
  return lines.join("\n");
}

/** Small seeded PRNG (mulberry32): same seed => same sequence in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compare two key tuples element by element (numbers or strings), first difference wins. */
function cmpTuple(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Numeric set key for (entity id, slot id). */
export const busyKey = (id: number, slot: number): number => id * 4096 + slot;

// --------------------------------------------------------------- the problem
/** Everything the scheduler needs, loaded once from MySQL by loadProblem(). */
export interface Problem {
  slots: Row[];
  slotIds: number[];
  slotDay: Map<number, string>;
  nextSlot: Map<number, number>;
  prevSlot: Map<number, number>;
  sections: Map<number, Row>;
  courses: Map<string, Row>;
  plan: Row[];
  teach: Map<string, number[]>; // course -> qualified faculty ids
  facultyName: Map<number, string>;
  rooms: Row[];
  conflict: Map<string, Map<string, number>>;
  windowCache: Map<number, number[][]>;
}

export async function loadProblem(db: Db): Promise<Problem> {
  const slots = await query(db, "SELECT slot_id, day_of_week, period_no, start_time, end_time FROM TimeSlot ORDER BY slot_id");
  const { next, prev } = buildSlotLinks(slots, LONG_BREAK_MIN);
  const byId = <K>(rows: Row[], key: string) => new Map<K, Row>(rows.map((r) => [r[key], r]));
  const teach = new Map<string, number[]>();
  for (const r of await query(db, "SELECT faculty_id, course_id FROM Teaches ORDER BY faculty_id")) {
    teach.set(r.course_id, [...(teach.get(r.course_id) ?? []), r.faculty_id]);
  }
  return {
    slots,
    slotIds: slots.map((s) => s.slot_id),
    slotDay: new Map(slots.map((s) => [s.slot_id, s.day_of_week])),
    nextSlot: next,
    prevSlot: prev,
    sections: byId(await query(db, "SELECT section_id, section_name, semester, strength, dept_id FROM Section"), "section_id"),
    courses: byId(await query(db, "SELECT course_id, course_name, weekly_hours, course_type FROM Course"), "course_id"),
    plan: await query(db, "SELECT section_id, course_id FROM Section_Course ORDER BY section_id, course_id"),
    teach,
    facultyName: new Map((await query(db, "SELECT faculty_id, name FROM Faculty")).map((r) => [r.faculty_id, r.name])),
    rooms: await query(db, "SELECT room_id, room_no, building, capacity, room_type FROM Classroom"),
    conflict: await buildConflictGraph(db),
    windowCache: new Map(),
  };
}

const facultyFor = (P: Problem, courseId: string): number[] => P.teach.get(courseId) ?? [];

function roomNeed(P: Problem, courseId: string): "LAB" | "LECTURE" {
  return P.courses.get(courseId)!.course_type === "LAB" ? "LAB" : "LECTURE";
}

/** Rooms that satisfy the hard room constraints for (section, course), best fit first. */
function eligibleRooms(P: Problem, sectionId: number, courseId: string): number[] {
  const need = roomNeed(P, courseId);
  const strength = P.sections.get(sectionId)!.strength;
  return P.rooms
    .filter((r) => r.room_type === need && r.capacity >= strength)
    .sort((a, b) => a.capacity - b.capacity || a.room_id - b.room_id)
    .map((r) => r.room_id);
}

/** All runs of `size` consecutive slot ids (no lunch break inside). */
function windows(P: Problem, size: number): number[][] {
  let out = P.windowCache.get(size);
  if (!out) {
    out = [];
    for (const sid of P.slotIds) {
      const win = [sid];
      let cur = sid;
      while (win.length < size && P.nextSlot.has(cur)) {
        cur = P.nextSlot.get(cur)!;
        win.push(cur);
      }
      if (win.length === size) out.push(win);
    }
    P.windowCache.set(size, out);
  }
  return out;
}

const conflictWeight = (P: Problem, courseId: string): number =>
  [...(P.conflict.get(courseId)?.values() ?? [])].reduce((a, b) => a + b, 0);

/** THEORY: one period per task. LAB: as few blocks as possible, each <= MAX_LAB_BLOCK. */
export function splitHours(hours: number, courseType: string): number[] {
  if (courseType !== "LAB") return Array<number>(hours).fill(1);
  const nBlocks = Math.ceil(hours / MAX_LAB_BLOCK);
  const base = Math.floor(hours / nBlocks), extra = hours % nBlocks;
  return Array.from({ length: nBlocks }, (_, i) => base + (i < extra ? 1 : 0));
}

export function makeTasks(P: Problem): Task[] {
  return P.plan.flatMap((row) => {
    const c = P.courses.get(row.course_id)!;
    return splitHours(c.weekly_hours, c.course_type).map((size, seq) => ({
      sectionId: row.section_id, courseId: row.course_id, blockSize: size, seq, courseType: c.course_type,
    }));
  });
}

// --------------------------------------------------------------- pre-flight
const inc = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

/** Necessary conditions only: if one fails, no timetable can exist. */
export function preflight(P: Problem, tasks: Task[]): string[] {
  const nSlots = P.slots.length;
  if (!nSlots) return ["TimeSlot is empty."];
  if (!P.plan.length) return ["Section_Course is empty: no section has any course to schedule."];
  const issues: string[] = [];
  const hoursBySection = new Map<number, number>();
  const hoursByCourse = new Map<string, number>();
  for (const { section_id: s, course_id: c } of P.plan) {
    const h = P.courses.get(c)!.weekly_hours;
    inc(hoursBySection, s, h);
    inc(hoursByCourse, c, h);
    if (!facultyFor(P, c).length) issues.push(`course ${c}: no faculty in Teaches (section ${s}).`);
    if (!eligibleRooms(P, s, c).length) {
      issues.push(`course ${c} / section ${s}: no ${roomNeed(P, c)} room with capacity >= ${P.sections.get(s)!.strength}.`);
    }
  }
  for (const [s, h] of hoursBySection) {
    if (h > nSlots) issues.push(`section ${s} needs ${h} periods/week but only ${nSlots} slots exist.`);
  }
  for (const [c, h] of hoursByCourse) {
    const n = facultyFor(P, c).length, cap = n * nSlots;
    if (n && h > cap) {
      issues.push(`course ${c} needs ${h} periods/week across sections but its ${n} qualified faculty offer at most ${cap}.`);
    }
  }
  for (const need of ["LAB", "LECTURE"]) {
    const demand = tasks.filter((t) => roomNeed(P, t.courseId) === need).reduce((a, t) => a + t.blockSize, 0);
    const nRooms = P.rooms.filter((r) => r.room_type === need).length;
    if (demand > nRooms * nSlots) {
      issues.push(`${need} rooms: ${demand} periods needed but ${nRooms} rooms x ${nSlots} slots = ${nRooms * nSlots}.`);
    }
  }
  return issues;
}

// ----------------------------------------------------------------- state
/** Mutable schedule under construction, with O(1) place/unplace. Busy sets hold busyKey(id, slot). */
export class State {
  busyRoom = new Set<number>();
  busyFac = new Set<number>();
  busySec = new Set<number>();
  secDay = new Map<string, number>(); // "section|day" -> periods
  facDay = new Map<string, number>(); // "faculty|day" -> periods
  courseDay = new Map<string, number>(); // "section|course|day" -> sessions

  constructor(private P: Problem) {}

  private apply(p: Placement, d: 1 | -1) {
    const t = p.task;
    const op = d > 0 ? "add" : "delete";
    for (const sl of p.slots) {
      const day = this.P.slotDay.get(sl)!;
      this.busyRoom[op](busyKey(p.roomId, sl));
      this.busyFac[op](busyKey(p.facultyId, sl));
      this.busySec[op](busyKey(t.sectionId, sl));
      inc(this.secDay, `${t.sectionId}|${day}`, d);
      inc(this.facDay, `${p.facultyId}|${day}`, d);
    }
    for (const day of new Set(p.slots.map((x) => this.P.slotDay.get(x)!))) {
      inc(this.courseDay, `${t.sectionId}|${t.courseId}|${day}`, d);
    }
  }

  place(p: Placement) { this.apply(p, 1); }
  unplace(p: Placement) { this.apply(p, -1); }
}

// -------------------------------------------------------------- scheduler
type Frame = { cands: Placement[]; next: number; applied: Placement | null };

export class Scheduler {
  state: State;
  private roomsCache = new Map<string, number[]>();

  constructor(readonly P: Problem, readonly rng: () => number) {
    this.state = new State(P);
  }

  roomsFor(t: Task): number[] {
    const key = `${t.sectionId}|${t.courseId}`;
    let r = this.roomsCache.get(key);
    if (!r) this.roomsCache.set(key, (r = eligibleRooms(this.P, t.sectionId, t.courseId)));
    return r;
  }

  /** Most constrained first. jitter > 0 perturbs the scores (used on restarts). */
  orderTasks(tasks: Task[], jitter: number): Task[] {
    const noise = new Map<string, number>();
    const keyed = tasks.map((t) => {
      const k = `${t.sectionId}|${t.courseId}`;
      if (!noise.has(k)) noise.set(k, 1 + jitter * this.rng());
      const n = noise.get(k)!;
      const score = [
        t.blockSize > 1 ? 1 : 0,
        n / Math.max(1, facultyFor(this.P, t.courseId).length), // few faculty = hard
        n / Math.max(1, this.roomsFor(t).length), // few rooms = hard
        n * conflictWeight(this.P, t.courseId), // conflict-graph degree
        this.P.courses.get(t.courseId)!.weekly_hours,
      ];
      // difficulty descending; ties keep (section, course, seq) order so a course's tasks stay adjacent
      return { t, key: [...score.map((x) => -x), t.sectionId, t.courseId, t.seq] };
    });
    return keyed.sort((a, b) => cmpTuple(a.key, b.key)).map((x) => x.t);
  }

  /** Soft-constraint penalty of giving `slots` of task t to faculty fac. */
  softPenalty(t: Task, fac: number, slots: number[]): number {
    const { P, state: st } = this;
    let pen = 0;
    for (const d of new Set(slots.map((x) => P.slotDay.get(x)!))) {
      pen += W_SAME_DAY * (st.courseDay.get(`${t.sectionId}|${t.courseId}|${d}`) ?? 0);
      pen += W_SEC_BALANCE * (st.secDay.get(`${t.sectionId}|${d}`) ?? 0);
      pen += W_FAC_BALANCE * (st.facDay.get(`${fac}|${d}`) ?? 0);
      if (d === "SAT") pen += W_SATURDAY;
    }
    // longest run of consecutive periods this faculty would then have
    const taken = (x: number) => slots.includes(x) || st.busyFac.has(busyKey(fac, x));
    let worst = 0;
    for (const sl of slots) {
      let run = 1;
      for (let x = P.prevSlot.get(sl); x !== undefined && taken(x); x = P.prevSlot.get(x)) run++;
      for (let x = P.nextSlot.get(sl); x !== undefined && taken(x); x = P.nextSlot.get(x)) run++;
      worst = Math.max(worst, run);
    }
    if (worst > MAX_FAC_CONSEC) pen += W_FAC_RUN * (worst - MAX_FAC_CONSEC);
    return pen;
  }

  /** All hard-constraint-valid placements of t, cheapest soft penalty first. */
  candidates(t: Task): Placement[] {
    const { P, state: st } = this;
    const rooms = this.roomsFor(t), facs = facultyFor(P, t.courseId);
    const out: { pen: number; tie: number; p: Placement }[] = [];
    for (const win of windows(P, t.blockSize)) {
      if (win.some((x) => st.busySec.has(busyKey(t.sectionId, x)))) continue;
      for (const f of facs) {
        if (win.some((x) => st.busyFac.has(busyKey(f, x)))) continue;
        let pen: number | null = null;
        let taken = 0;
        for (const r of rooms) { // best-fit rooms first
          if (win.some((x) => st.busyRoom.has(busyKey(r, x)))) continue;
          pen ??= this.softPenalty(t, f, win);
          out.push({ pen, tie: this.rng(), p: { task: t, facultyId: f, roomId: r, slots: win, penalty: pen } });
          if (++taken >= K_ROOMS) break;
        }
      }
    }
    out.sort((a, b) => a.pen - b.pen || a.tie - b.tie);
    const result = out.map((x) => x.p);
    if (t.blockSize > 1) result.push(...this.scattered(t, rooms, facs)); // soft fallback: split the lab hours
    return result;
  }

  /** Fallback when no consecutive window works: free periods on distinct days. */
  private scattered(t: Task, rooms: number[], facs: number[], limit = 6): Placement[] {
    const { P, state: st } = this;
    const found: Placement[] = [];
    for (const f of facs) {
      for (const r of rooms.slice(0, K_ROOMS)) {
        const free = P.slotIds
          .filter((x) => !st.busySec.has(busyKey(t.sectionId, x)) && !st.busyFac.has(busyKey(f, x)) && !st.busyRoom.has(busyKey(r, x)))
          .map((x) => ({ x, pen: this.softPenalty(t, f, [x]) }))
          .sort((a, b) => a.pen - b.pen)
          .map((e) => e.x);
        const chosen: number[] = [];
        const usedDays = new Set<string>();
        for (const x of free) { // prefer distinct days first
          if (!usedDays.has(P.slotDay.get(x)!)) {
            chosen.push(x);
            usedDays.add(P.slotDay.get(x)!);
          }
          if (chosen.length === t.blockSize) break;
        }
        for (const x of free) { // then top up from any day
          if (chosen.length === t.blockSize) break;
          if (!chosen.includes(x)) chosen.push(x);
        }
        if (chosen.length === t.blockSize) {
          const slots = chosen.sort((a, b) => a - b);
          found.push({ task: t, facultyId: f, roomId: r, slots, penalty: W_SCATTER + this.softPenalty(t, f, slots) });
        }
      }
    }
    return found.sort((a, b) => a.penalty - b.penalty).slice(0, limit);
  }

  /**
   * Iterative DFS with an explicit stack: stack[i] = candidates of level i, next index to try and
   * the placement currently applied. A level's candidate list stays valid while deeper levels are
   * explored, because levels < i are unchanged and level i's own placement is undone before the
   * next candidate is applied. Returns the placements (or null) and the nodes used.
   */
  solve(tasks: Task[], maxNodes: number, deadline: number): { placements: Placement[] | null; nodes: number } {
    this.state = new State(this.P);
    const stack: Frame[] = [];
    let i = 0, nodes = 0;
    while (i >= 0 && i < tasks.length) {
      if (nodes >= maxNodes || now() > deadline) return { placements: null, nodes };
      if (i === stack.length) stack.push({ cands: this.candidates(tasks[i]), next: 0, applied: null }); // first visit
      const frame = stack[i];
      if (frame.applied) { // undo the previous try here
        this.state.unplace(frame.applied);
        frame.applied = null;
      }
      if (frame.next < frame.cands.length) {
        const p = frame.cands[frame.next++];
        nodes++;
        this.state.place(p);
        frame.applied = p;
        i++;
      } else { // dead end: backtrack
        stack.pop();
        i--;
      }
    }
    if (i < 0) return { placements: null, nodes }; // whole tree exhausted
    return { placements: stack.map((f) => f.applied!), nodes };
  }

  /** No backtracking: place what fits, explain what does not. */
  greedyPartial(tasks: Task[]): { placed: Placement[]; unplaced: [Task, string][] } {
    this.state = new State(this.P);
    const placed: Placement[] = [], unplaced: [Task, string][] = [];
    for (const t of tasks) {
      const c = this.candidates(t);
      if (c.length) {
        this.state.place(c[0]);
        placed.push(c[0]);
      } else unplaced.push([t, this.diagnose(t)]);
    }
    return { placed, unplaced };
  }

  diagnose(t: Task): string {
    const { P, state: st } = this;
    const facs = facultyFor(P, t.courseId), rooms = this.roomsFor(t);
    const need = roomNeed(P, t.courseId);
    const strength = P.sections.get(t.sectionId)!.strength;
    if (!facs.length) return "no faculty listed in Teaches for this course";
    if (!rooms.length) return `no ${need} room with capacity >= ${strength}`;
    let secBusy = 0, noFac = 0, noRoom = 0, usable = 0;
    for (const sl of P.slotIds) {
      if (st.busySec.has(busyKey(t.sectionId, sl))) secBusy++;
      else if (facs.every((f) => st.busyFac.has(busyKey(f, sl)))) noFac++;
      else if (rooms.every((r) => st.busyRoom.has(busyKey(r, sl)))) noRoom++;
      else usable++;
    }
    const names = facs.map((f) => P.facultyName.get(f) ?? String(f)).join(", ");
    let msg = `of ${P.slotIds.length} slots: ${secBusy} already used by the section, ` +
      `${noFac} have every qualified faculty (${names}) busy, ` +
      `${noRoom} have no free ${need} room with >= ${strength} seats, ${usable} usable`;
    if (t.blockSize > 1 && usable) msg += ` (but no ${t.blockSize} consecutive free periods together)`;
    return msg;
  }
}

const now = (): number => performance.now() / 1000;

// ------------------------------------------------------- soft-constraint audit
/** Independent audit of the soft constraints (used in the report and tests). */
export function evaluateSoft(P: Problem, placements: Placement[]): Soft {
  const perCourseDay = new Map<string, number>();
  const facSlots = new Map<number, Set<number>>();
  let labSplit = 0;
  for (const p of placements) {
    const t = p.task;
    for (const d of new Set(p.slots.map((x) => P.slotDay.get(x)!))) inc(perCourseDay, `${t.sectionId}|${t.courseId}|${d}`);
    if (!facSlots.has(p.facultyId)) facSlots.set(p.facultyId, new Set());
    p.slots.forEach((x) => facSlots.get(p.facultyId)!.add(x));
    if (t.blockSize > 1 && p.slots.slice(1).some((b, i) => P.nextSlot.get(p.slots[i]) !== b)) labSplit++;
  }
  const repeats = [...perCourseDay.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);
  let longRuns = 0;
  for (const slots of facSlots.values()) {
    for (const sl of slots) {
      const before = P.prevSlot.get(sl);
      if (before !== undefined && slots.has(before)) continue; // not the start of a run
      let run = 1;
      for (let x = P.nextSlot.get(sl); x !== undefined && slots.has(x); x = P.nextSlot.get(x)) run++;
      if (run > MAX_FAC_CONSEC) longRuns++;
    }
  }
  return { same_day_repeats: repeats, faculty_long_runs: longRuns, lab_blocks_split: labSplit };
}

// ----------------------------------------------------------------- saving
const isMysqlError = (e: unknown): boolean => typeof (e as { errno?: unknown })?.errno === "number";

/**
 * Replace the year's timetable atomically. Any MySQL error rolls everything back (the old timetable
 * survives) and is raised as a GenerationError with a plain-English reason and the offending row.
 */
export async function saveTimetable(conn: PoolConnection, year: string, rows: TimetableRow[]): Promise<void> {
  await transaction(conn, async () => {
    await conn.query("DELETE FROM Timetable WHERE academic_year = ?", [year]);
    for (const row of rows) {
      try {
        await conn.query("INSERT INTO Timetable (course_id, faculty_id, room_id, slot_id, section_id, academic_year) " +
          "VALUES (?, ?, ?, ?, ?, ?)", row);
      } catch (e) {
        if (!isMysqlError(e)) throw e;
        throw new GenerationError(`${describeMysqlError(e)} ` +
          `[course=${row[0]} faculty=${row[1]} room=${row[2]} slot=${row[3]} section=${row[4]}]`, { cause: e });
      }
    }
  });
}

// ------------------------------------------------------ what-if validation
async function one(db: Db, sql: string, params: unknown[]): Promise<Row | null> {
  return (await query(db, sql, params))[0] ?? null;
}

/**
 * Would this class be accepted? Checks every rule WITHOUT writing anything; one result per rule.
 * hard=true rules are enforced by MySQL (unique keys, foreign keys, triggers); the weekly-hours
 * rule only by the generator.
 */
export async function checkProposedClass(conn: Db, year: string, sectionId: number, courseId: string,
  facultyId: number, roomId: number, slotId: number): Promise<CheckResult[]> {
  const sec = await one(conn, "SELECT strength FROM Section WHERE section_id = ?", [sectionId]);
  const crs = await one(conn, "SELECT course_type, weekly_hours FROM Course WHERE course_id = ?", [courseId]);
  const room = await one(conn, "SELECT building, room_no, capacity, room_type FROM Classroom WHERE room_id = ?", [roomId]);
  const taught = await one(conn, "SELECT 1 AS x FROM Teaches WHERE faculty_id = ? AND course_id = ?", [facultyId, courseId]);
  const planned = await one(conn, "SELECT 1 AS x FROM Section_Course WHERE section_id = ? AND course_id = ?", [sectionId, courseId]);
  const busy = await query(conn, "SELECT t.section_id, t.faculty_id, t.room_id, t.course_id FROM Timetable t " +
    "WHERE t.academic_year = ? AND t.slot_id = ? AND (t.section_id = ? OR t.faculty_id = ? OR t.room_id = ?)",
  [year, slotId, sectionId, facultyId, roomId]);
  const done = Number((await one(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ? AND section_id = ? " +
    "AND course_id = ?", [year, sectionId, courseId]))!.n);

  const clash = (rule: string, col: string, value: number | string): CheckResult => {
    const hit = busy.find((b) => b[col] === value);
    return { rule, ok: !hit, hard: true, detail: hit ? `already used by a ${hit.course_id} class in this slot` : "free" };
  };
  const need = crs?.course_type === "LAB" ? "LAB" : "LECTURE";
  const out: CheckResult[] = [
    clash("Section is free in this slot", "section_id", sectionId),
    clash("Faculty is free in this slot", "faculty_id", facultyId),
    clash("Room is free in this slot", "room_id", roomId),
    { rule: "Faculty is qualified (Teaches)", ok: !!taught, hard: true,
      detail: taught ? "listed in Teaches" : "not listed in Teaches for this course" },
    { rule: "Course is in the section's plan (Section_Course)", ok: !!planned, hard: true,
      detail: planned ? "in the plan" : "section does not take this course" },
  ];
  if (crs && room) {
    out.push({ rule: "Room type fits the course", ok: room.room_type === need, hard: true,
      detail: `${crs.course_type} course needs a ${need} room; ${room.building}-${room.room_no} is ${room.room_type}` });
  }
  if (sec && room) {
    out.push({ rule: "Room capacity >= section strength", ok: room.capacity >= sec.strength, hard: true,
      detail: `capacity ${room.capacity} vs strength ${sec.strength}` });
  }
  if (crs) {
    out.push({ rule: "Section still needs hours for this course", ok: done < crs.weekly_hours, hard: false,
      detail: `${done} of ${crs.weekly_hours} weekly periods already scheduled` });
  }
  return out;
}

// ------------------------------------------------------- substitute assignment
/**
 * Hand one saved class (a Timetable row) to another faculty member, in ONE transaction.
 *
 * This changes the weekly timetable (Timetable.faculty_id): a reassignment, not a one-day cover.
 * Rules (checked here for a friendly message, enforced again by MySQL: uq_faculty_slot,
 * fk_tt_teaches, the BEFORE UPDATE trigger):
 *   - the new faculty member must be free in that slot of that academic year;
 *   - they must be listed in Teaches for the course. A RELATED candidate (Neo4j substitute finder)
 *     is not: pass addTeaches to insert that Teaches row in the same transaction.
 * Returns a change record; pass it to revertSubstitution() to undo. Refresh the Neo4j graph
 * afterwards (runEtl(year)) so the graph tools see the change.
 */
export async function assignSubstitute(conn: PoolConnection, timetableId: number, facultyId: number,
  opts: { addTeaches?: boolean; dropTeaches?: [number, string] } = {}): Promise<SubstitutionChange> {
  const cls = await one(conn, "SELECT t.timetable_id, t.course_id, t.faculty_id, t.slot_id, t.section_id, t.academic_year, " +
    "f.name AS faculty_name FROM Timetable t JOIN Faculty f ON f.faculty_id = t.faculty_id WHERE t.timetable_id = ?", [timetableId]);
  if (!cls) throw new SubstitutionError(`no saved class with timetable_id=${timetableId}`);
  const sub = await one(conn, "SELECT faculty_id, name FROM Faculty WHERE faculty_id = ?", [facultyId]);
  if (!sub) throw new SubstitutionError(`unknown faculty_id=${facultyId}`);
  if (sub.faculty_id === cls.faculty_id) throw new SubstitutionError(`${sub.name} already teaches this class`);
  const busy = await one(conn, "SELECT course_id, section_id FROM Timetable WHERE academic_year = ? AND slot_id = ? " +
    "AND faculty_id = ?", [cls.academic_year, cls.slot_id, facultyId]);
  if (busy) {
    throw new SubstitutionError(`${sub.name} already teaches ${busy.course_id} (section ${busy.section_id}) in that slot`);
  }
  const qualified = !!(await one(conn, "SELECT 1 AS x FROM Teaches WHERE faculty_id = ? AND course_id = ?", [facultyId, cls.course_id]));
  if (!qualified && !opts.addTeaches) {
    throw new SubstitutionError(`${sub.name} is not listed in Teaches for ${cls.course_id}; ` +
      "add the Teaches row first (add_teaches=True)");
  }

  await conn.rollback(); // end any read snapshot; the writes below are one transaction
  try {
    await transaction(conn, async () => {
      if (!qualified) await conn.query("INSERT INTO Teaches (faculty_id, course_id) VALUES (?, ?)", [facultyId, cls.course_id]);
      // "AND faculty_id = old" guards against someone else having changed the row meanwhile
      const [res] = await conn.query<ResultSetHeader>("UPDATE Timetable SET faculty_id = ? WHERE timetable_id = ? AND faculty_id = ?",
        [facultyId, timetableId, cls.faculty_id]);
      if (res.affectedRows !== 1) throw new SubstitutionError("the class was changed by someone else; reload and try again");
      if (opts.dropTeaches) { // used by revertSubstitution: remove the row it added
        await conn.query("DELETE FROM Teaches WHERE faculty_id = ? AND course_id = ?", opts.dropTeaches);
      }
    });
  } catch (e) {
    if (isMysqlError(e)) throw new SubstitutionError(describeMysqlError(e), { cause: e });
    throw e;
  }
  return {
    timetable_id: timetableId, academic_year: cls.academic_year, course_id: cls.course_id, section_id: cls.section_id,
    slot_id: cls.slot_id, old_faculty_id: cls.faculty_id, old_faculty: cls.faculty_name,
    new_faculty_id: sub.faculty_id, new_faculty: sub.name, teaches_added: !qualified,
  };
}

/** Undo assignSubstitute(): give the class back and drop the Teaches row it added (one transaction). */
export async function revertSubstitution(conn: PoolConnection, change: SubstitutionChange): Promise<SubstitutionChange> {
  const drop: [number, string] | undefined = change.teaches_added ? [change.new_faculty_id, change.course_id] : undefined;
  return assignSubstitute(conn, change.timetable_id, change.old_faculty_id, { dropTeaches: drop });
}

// ------------------------------------------------------------- main entry
/**
 * Build a timetable for opts.academicYear and (unless dryRun) save it.
 *   replace       overwrite existing rows of that year (else refuse if any exist)
 *   allowPartial  save a clash-free partial timetable if a complete one is impossible
 *   dryRun        compute and report only; never touch MySQL data
 */
export async function generateTimetable(opts: GenerateOptions = {}): Promise<GenerationResult> {
  const { replace = false, allowPartial = false, dryRun = false, timeLimit = 30, maxNodes = 300_000,
    restarts = 4, seed = 42 } = opts;
  const year = opts.academicYear || academicYear();
  const res: GenerationResult = {
    academic_year: year, required: 0, placed: 0, complete: false, committed: false, rows: [], unplaced: [],
    preflight: [], soft: {}, nodes: 0, attempts: 0, elapsed: 0, error: null, note: null,
  };
  const t0 = now();
  const conn = opts.conn ?? (await pool().getConnection());
  try {
    const existing = Number((await one(conn, "SELECT COUNT(*) AS n FROM Timetable WHERE academic_year = ?", [year]))!.n);
    const P = await loadProblem(conn);
    const tasks = makeTasks(P);
    res.required = tasks.reduce((a, t) => a + t.blockSize, 0);

    res.preflight = preflight(P, tasks);
    if (res.preflight.length) {
      res.note = "input data makes a timetable impossible";
      return res;
    }

    let placements: Placement[] | null = null;
    const deadline = t0 + timeLimit;
    const attempts = Math.max(1, restarts); // restarts=0 still means one attempt
    for (let attempt = 0; attempt < attempts && !placements; attempt++) {
      const start = now();
      const share = (deadline - start) / (attempts - attempt);
      const sched = new Scheduler(P, mulberry32(seed + attempt));
      const ordered = sched.orderTasks(tasks, attempt === 0 ? 0 : 0.4);
      const found = sched.solve(ordered, Math.floor(maxNodes / attempts), start + share);
      placements = found.placements;
      res.nodes += found.nodes;
      res.attempts = attempt + 1;
    }

    if (placements) res.complete = true;
    else {
      // no complete timetable within budget: best effort + diagnosis, one entry per (section, course)
      const sched = new Scheduler(P, mulberry32(seed));
      const partial = sched.greedyPartial(sched.orderTasks(tasks, 0));
      placements = partial.placed;
      const grouped = new Map<string, Unplaced>();
      for (const [t, why] of partial.unplaced) {
        const k = `${t.sectionId}|${t.courseId}`;
        if (!grouped.has(k)) grouped.set(k, { section: t.sectionId, course: t.courseId, periods: 0, reason: why });
        grouped.get(k)!.periods += t.blockSize;
      }
      res.unplaced = [...grouped.values()];
    }

    res.placed = placements.reduce((a, p) => a + p.slots.length, 0);
    res.soft = evaluateSoft(P, placements);
    res.rows = placements
      .flatMap((p) => p.slots.map((sl): TimetableRow => [p.task.courseId, p.facultyId, p.roomId, sl, p.task.sectionId, year]))
      .sort((a, b) => a[4] - b[4] || a[3] - b[3]);

    if (dryRun) res.note = "dry run";
    else if (!res.complete && !allowPartial) {
      res.note = "incomplete timetable not saved (use allow_partial to keep a partial one)";
    } else if (existing && !replace) {
      res.note = `${existing} rows already exist for ${year}; tick Replace / pass --replace to overwrite`;
    } else {
      try {
        await saveTimetable(conn, year, res.rows);
        res.committed = true;
      } catch (e) {
        if (!(e instanceof GenerationError)) throw e;
        res.error = e.message;
        res.note = "save failed, transaction rolled back";
      }
    }
    return res;
  } finally {
    res.elapsed = now() - t0;
    if (!opts.conn) conn.release();
  }
}

export type { Row };
