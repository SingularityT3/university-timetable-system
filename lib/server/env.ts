/**
 * Configuration from environment variables and the project-root .env file.
 * Next.js loads .env itself; scripts and tests call loadEnv() (same rules: real env vars win).
 */
import { loadEnvConfig } from "@next/env";

export const PROJECT_ROOT = process.cwd();
export const DEFAULT_ACADEMIC_YEAR = "2026-2027";

let loaded = false;
export function loadEnv(): void {
  if (!loaded) {
    loadEnvConfig(PROJECT_ROOT, false, { info: () => {}, error: console.error });
    loaded = true;
  }
}

export function env(name: string, fallback?: string): string | undefined {
  loadEnv();
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/** Academic year used by default (env ACADEMIC_YEAR, else 2026-2027). */
export function academicYear(): string {
  return env("ACADEMIC_YEAR", DEFAULT_ACADEMIC_YEAR)!;
}
