export interface Bar {
  label: string;
  value: number;
}

/** Horizontal bar chart made of CSS bars (no chart library). */
export function BarChart({ data, unit = "", title }: { data: Bar[]; unit?: string; title?: string }) {
  if (data.length === 0) return <p className="muted empty">No data.</p>;
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <figure className="bar-chart">
      {title && <figcaption>{title}</figcaption>}
      {data.map((d) => (
        <div className="bar-row" key={d.label}>
          <span className="bar-label" title={d.label}>
            {d.label}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(Math.max(d.value, 0) / max) * 100}%` }} />
          </span>
          <span className="bar-value">
            {Number.isInteger(d.value) ? d.value : d.value.toFixed(1)}
            {unit}
          </span>
        </div>
      ))}
    </figure>
  );
}
