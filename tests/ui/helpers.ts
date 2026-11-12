import type { Meta, User } from "@/lib/types";

/** Stub global fetch with one queued JSON response per call. */
export function mockFetch(...responses: { status?: number; body?: unknown }[]) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses.shift() ?? { status: 200, body: {} };
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const adminUser: User = { user_id: 1, username: "admin", role: "admin", faculty_id: null, faculty_name: null };
export const facultyUser: User = { user_id: 2, username: "faculty1", role: "faculty", faculty_id: 1, faculty_name: "Dr. Rao" };

export const meta: Meta = {
  default_year: "2026-2027",
  years: ["2026-2027"],
  days: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
  sections: [{ id: 1, label: "Computer Science and Engineering / Sem 3 / A" }],
  faculty: [{ id: 1, label: "Dr. Rao (Computer Science and Engineering)", name: "Dr. Rao" }],
  rooms: [{ id: 1, label: "A-Block 101 (LECTURE, 60 seats)" }],
  courses: [{ id: "CS301", label: "CS301 Data Structures (THEORY)" }],
  slots: [{ id: 1, label: "MON P1 08:30", day_of_week: "MON", period_no: 1, start_time: "08:30", end_time: "09:20" }],
  neo4j: { ok: false, detail: "ServiceUnavailable" },
  counts: { "2026-2027": 240 },
};

/** Stub global fetch answering 200 with the body of the first route whose path prefix matches. */
export function mockRoutes(routes: Record<string, unknown>) {
  const fn = vi.fn(async (url: string) => {
    const hit = Object.keys(routes).find((p) => url.startsWith(`/api${p}`));
    return new Response(JSON.stringify(hit ? routes[hit] : { detail: "not mocked" }), {
      status: hit ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
