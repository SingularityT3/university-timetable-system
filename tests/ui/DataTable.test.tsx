import { fireEvent, render, screen } from "@testing-library/react";
import { DataTable } from "@/components/DataTable";

describe("DataTable", () => {
  it("derives columns from the first row and formats values", () => {
    render(<DataTable rows={[{ course: "CS301", types: ["ROOM", "FACULTY"], n: 3, extra: null }]} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["course", "types", "n", "extra"]);
    expect(screen.getByText("ROOM, FACULTY")).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveClass("num");
  });

  it("uses explicit columns with labels and custom renderers", () => {
    render(
      <DataTable
        rows={[{ a: 1, b: "x" }]}
        columns={[{ key: "b", label: "Bee" }, { key: "a", label: "Doubled", render: (r) => r.a * 2 }]}
      />,
    );
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Bee", "Doubled"]);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows the empty message when there are no rows", () => {
    render(<DataTable rows={[]} empty="Nothing here." />);
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("calls onRowClick with the row", () => {
    const onRowClick = vi.fn();
    render(<DataTable rows={[{ id: 7, name: "Lab 2" }]} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText("Lab 2"));
    expect(onRowClick).toHaveBeenCalledWith({ id: 7, name: "Lab 2" });
  });
});
