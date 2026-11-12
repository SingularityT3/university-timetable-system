import { render, screen } from "@testing-library/react";
import { AppContextProvider } from "@/components/AppProvider";
import { Sidebar } from "@/components/Sidebar";
import type { User } from "@/lib/types";
import { adminUser, facultyUser, meta } from "./helpers";

vi.mock("next/navigation", () => ({ usePathname: () => "/timetable" }));

function renderAs(user: User) {
  const value = {
    user, meta, year: "2026-2027", setYear: vi.fn(), isAdmin: user.role === "admin", refreshMeta: vi.fn(),
  };
  return render(
    <AppContextProvider value={value}>
      <Sidebar />
    </AppContextProvider>,
  );
}

describe("Sidebar", () => {
  it("hides admin-only pages from faculty users", () => {
    renderAs(facultyUser);
    expect(screen.queryByRole("link", { name: "Run generator" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Timetable" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Graph (Neo4j)" })).toBeInTheDocument();
    expect(screen.getByText("faculty")).toHaveClass("badge");
    expect(screen.getByText("Dr. Rao")).toBeInTheDocument();
  });

  it("shows every page to admins and marks the current one", () => {
    renderAs(adminUser);
    expect(screen.getByRole("link", { name: "Run generator" })).toHaveAttribute("href", "/generator");
    expect(screen.getByRole("link", { name: "Timetable" })).toHaveClass("active");
  });

  it("shows the status captions", () => {
    renderAs(adminUser);
    expect(screen.getByText("MySQL: connected")).toBeInTheDocument();
    expect(screen.getByText("Neo4j: unavailable (ServiceUnavailable)")).toBeInTheDocument();
    expect(screen.getByText("240 classes saved for 2026-2027")).toBeInTheDocument();
  });
});
