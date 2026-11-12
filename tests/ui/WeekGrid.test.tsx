import { render, screen, within } from "@testing-library/react";
import { WeekGrid } from "@/components/WeekGrid";
import type { Grid } from "@/lib/types";

const grid: Grid = {
  days: ["MON", "TUE"],
  rows: [
    {
      kind: "period",
      label: "P1",
      sub: "08:30 - 09:20",
      cells: {
        MON: [{ course_id: "CS301", course_type: "THEORY", lines: ["CS301", "Dr. Rao", "A-Block 101"] }],
        TUE: [{ course_id: "CS391", course_type: "LAB", lines: ["CS391", "CSE Sem 3 A", "Lab 2"] }],
      },
    },
    { kind: "break", label: "Lunch", sub: "12:05 - 13:00", cells: {} },
    { kind: "period", label: "P5", sub: "13:00 - 13:50", cells: { MON: [], TUE: [] } },
  ],
};

describe("WeekGrid", () => {
  it("renders a header per day plus the period column", () => {
    render(<WeekGrid grid={grid} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Period", "MON", "TUE"]);
  });

  it("renders break rows as one cell spanning all days", () => {
    render(<WeekGrid grid={grid} />);
    const row = screen.getByText("12:05 - 13:00").closest("tr")!;
    expect(row).toHaveClass("break-row");
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(2);
    expect(cells[1]).toHaveAttribute("colspan", "2");
    expect(cells[1]).toHaveTextContent("Lunch");
  });

  it("colours theory and lab blocks differently and shows every line", () => {
    render(<WeekGrid grid={grid} />);
    const theory = screen.getByText("CS301").closest(".class-block")!;
    const lab = screen.getByText("CS391").closest(".class-block")!;
    expect(theory).toHaveClass("theory");
    expect(lab).toHaveClass("lab");
    expect(theory).toHaveTextContent("Dr. Rao");
    expect(theory).toHaveTextContent("A-Block 101");
    expect(lab).toHaveTextContent("CSE Sem 3 A");
    expect(screen.getByText("CS301").tagName).toBe("STRONG");
  });
});
