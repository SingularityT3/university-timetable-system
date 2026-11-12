import { render, screen } from "@testing-library/react";
import { BarChart } from "@/components/BarChart";

describe("BarChart", () => {
  it("scales bars relative to the largest value", () => {
    const { container } = render(
      <BarChart data={[{ label: "MON", value: 40 }, { label: "TUE", value: 20 }, { label: "WED", value: 0 }]} />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>(".bar-fill")].map((b) => b.style.width);
    expect(widths).toEqual(["100%", "50%", "0%"]);
    expect(screen.getByText("MON")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("formats fractions and appends the unit", () => {
    render(<BarChart data={[{ label: "A 101", value: 37.5 }]} unit="%" />);
    expect(screen.getByText("37.5%")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    render(<BarChart data={[]} />);
    expect(screen.getByText("No data.")).toBeInTheDocument();
  });
});
