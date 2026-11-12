import { fireEvent, render, screen } from "@testing-library/react";
import AbsentPage from "@/app/(main)/absent/page";
import { AppContextProvider } from "@/components/AppProvider";
import type { AbsencePlan, User } from "@/lib/types";
import { adminUser, facultyUser, meta, mockFetch, mockRoutes } from "./helpers";

const plan: AbsencePlan = {
  summary: { classes_affected: 1, sections_affected: 1, students_affected: 60, coverable: 0, needs_teaches_row: 1, uncovered: 0 },
  stale: null,
  classes: [
    {
      timetable_id: 9, day: "MON", period: 1, start_time: "08:30", course_id: "CS301", course_name: "Data Structures",
      section_id: 1, section: "CSE-3A", room: "A-101", students: 60, status: "NEEDS_TEACHES",
      substitutes: [{ candidate_id: 4, candidate: "Dr. Iyer", fit: "RELATED", related_courses: ["CS302"] }],
    },
  ],
};

function renderAs(user: User) {
  mockRoutes({ "/absence": plan });
  return render(
    <AppContextProvider value={{ user, meta, year: "2026-2027", setYear: vi.fn(), isAdmin: user.role === "admin", refreshMeta: vi.fn() }}>
      <AbsentPage />
    </AppContextProvider>,
  );
}

describe("faculty absent page", () => {
  it("needs the Teaches checkbox before a RELATED candidate can be assigned", async () => {
    renderAs(adminUser);
    const assign = await screen.findByRole("button", { name: "Assign Dr. Iyer to this class" });
    expect(assign).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Also add Dr. Iyer to Teaches for CS301/ }));
    expect(assign).toBeEnabled();
    expect(screen.getByText("⚠️ Needs Teaches row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download plan as CSV/ })).toBeInTheDocument();
  });

  it("hides the assign controls from faculty users", async () => {
    renderAs(facultyUser);
    expect(await screen.findAllByText("Dr. Iyer")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
  });

  it("keeps the ETL result on screen after the refresh fixed the stale graph", async () => {
    const stale = "The Neo4j graph differs from MySQL for 2026-2027 (graph: 0 classes, MySQL: 1; 1 per-faculty count(s) differ).";
    mockFetch(
      { body: { ...plan, stale } },                     // GET /absence: graph out of date
      { body: { ok: true, problems: [], log: ["done"] } }, // POST /etl
      { body: plan },                                   // GET /absence again: up to date
    );
    render(
      <AppContextProvider
        value={{ user: adminUser, meta, year: "2026-2027", setYear: vi.fn(), isAdmin: true, refreshMeta: vi.fn(async () => {}) }}
      >
        <AbsentPage />
      </AppContextProvider>,
    );
    expect(await screen.findByText(stale)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update Neo4j graph for 2026-2027" }));
    expect(await screen.findByText("Neo4j graph matches MySQL.")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByText(stale)).not.toBeInTheDocument());
    expect(screen.getByText("Neo4j graph matches MySQL.")).toBeInTheDocument();
  });
});
