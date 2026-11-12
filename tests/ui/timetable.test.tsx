import { render, screen } from "@testing-library/react";
import TimetablePage from "@/app/(main)/timetable/page";
import { AppContextProvider } from "@/components/AppProvider";
import { facultyUser, meta, mockRoutes } from "./helpers";

const empty = { grid: { days: ["MON"], rows: [] }, rows: [], metrics: { periods: 0, courses: 0, days: 0 } };

describe("timetable page", () => {
  it("opens a faculty user's own timetable and shows the free blocks panel", async () => {
    const fetch = mockRoutes({ "/timetable": empty, "/free-blocks": [] });
    render(
      <AppContextProvider
        value={{ user: facultyUser, meta, year: "2026-2027", setYear: vi.fn(), isAdmin: false, refreshMeta: vi.fn() }}
      >
        <TimetablePage />
      </AppContextProvider>,
    );
    expect(await screen.findByText(/No classes saved for 2026-2027/)).toBeInTheDocument();
    const urls = fetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/timetable?year=2026-2027&view=faculty&id=1");
    expect(urls).toContain("/api/free-blocks?year=2026-2027&kind=FACULTY&id=1");
    expect(screen.getByRole("radio", { name: "Faculty" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument();
  });
});
