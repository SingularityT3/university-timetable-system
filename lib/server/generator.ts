/**
 * STUB written by the coordinator: signatures only. The scheduler agent replaces it with
 * the port of src/generator.py.
 */
import type { PoolConnection } from "mysql2/promise";
import type { Row } from "./db";

export const MAX_FAC_CONSEC = 3;

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

export interface GenerationResult {
  academic_year: string;
  required: number;
  placed: number;
  complete: boolean;
  committed: boolean;
  rows: [string, number, number, number, number, string][]; // course, faculty, room, slot, section, year
  unplaced: { section: string; course: string; periods: number; reason: string }[];
  preflight: string[];
  soft: { same_day_repeats: number; faculty_long_runs: number; lab_blocks_split: number } | Record<string, never>;
  nodes: number;
  attempts: number;
  elapsed: number;
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

export class SubstitutionError extends Error {}
export class GenerationError extends Error {}

const todo = (): never => {
  throw new Error("not implemented yet");
};

export function resultStatus(r: GenerationResult): "COMPLETE" | "PARTIAL" | "FAILED" { return todo(); } // eslint-disable-line
export function isSuccess(r: GenerationResult): boolean { return todo(); } // eslint-disable-line
/** Same text as GenerationResult.report() in Python. */
export function report(r: GenerationResult): string { return todo(); } // eslint-disable-line
export async function generateTimetable(opts?: GenerateOptions): Promise<GenerationResult> { return todo(); } // eslint-disable-line
export async function checkProposedClass(conn: PoolConnection, year: string, sectionId: number, courseId: string, facultyId: number, roomId: number, slotId: number): Promise<CheckResult[]> { return todo(); } // eslint-disable-line
export async function assignSubstitute(conn: PoolConnection, timetableId: number, facultyId: number, opts?: { addTeaches?: boolean; dropTeaches?: [number, string] }): Promise<SubstitutionChange> { return todo(); } // eslint-disable-line
export async function revertSubstitution(conn: PoolConnection, change: SubstitutionChange): Promise<SubstitutionChange> { return todo(); } // eslint-disable-line
export type { Row };
