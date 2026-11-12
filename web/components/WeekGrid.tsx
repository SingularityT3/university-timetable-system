import type { Grid } from "@/lib/types";

/** Weekly timetable grid (port of utils.grid_to_html): periods x days, break rows span all days. */
export function WeekGrid({ grid }: { grid: Grid }) {
  return (
    <div className="table-wrap">
      <table className="week-grid">
        <thead>
          <tr>
            <th className="period-col">Period</th>
            {grid.days.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row) => (
            <tr key={`${row.kind}-${row.label}-${row.sub}`} className={row.kind === "break" ? "break-row" : undefined}>
              <td className="period-col">
                <strong>{row.label}</strong>
                <br />
                <span className="muted">{row.sub}</span>
              </td>
              {row.kind === "break" ? (
                <td colSpan={grid.days.length} className="break-cell">
                  {row.label}
                </td>
              ) : (
                grid.days.map((d) => (
                  <td key={d}>
                    {(row.cells[d] ?? []).map((c, i) => (
                      <div key={i} className={`class-block ${c.course_type === "LAB" ? "lab" : "theory"}`}>
                        {c.lines.map((line, j) => (j === 0 ? <strong key={j}>{line}</strong> : <div key={j}>{line}</div>))}
                      </div>
                    ))}
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
