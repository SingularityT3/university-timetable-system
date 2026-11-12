import { fireEvent, render, screen } from "@testing-library/react";
import AbsentPage from "@/app/(main)/absent/page";
import { AppContextProvider } from "@/components/AppProvider";
import type { AbsencePlan, User } from "@/lib/types";
import { adminUser, facultyUser, meta, mockRoutes } from "./helpers";

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
});
