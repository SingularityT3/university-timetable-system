export interface Column<T> {
  key: string;
  label?: string;
  render?: (row: T) => React.ReactNode;
  numeric?: boolean;
}

/** Plain-text rendering of one cell value (arrays joined, objects as JSON). */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

interface Props<T> {
  rows: T[];
  /** Defaults to every key of the first row (like a pandas DataFrame). */
  columns?: Column<T>[];
  empty?: string;
  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  caption?: string;
}

export function DataTable<T extends object>({ rows, columns, empty = "No rows.", onRowClick, isSelected, caption }: Props<T>) {
  if (rows.length === 0) return <p className="muted empty">{empty}</p>;
  const cols: Column<T>[] = columns ?? Object.keys(rows[0]).map((key) => ({ key }));
  return (
    <div className="table-wrap">
      <table className="data-table">
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key}>{c.label ?? c.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={[onRowClick ? "clickable" : "", isSelected?.(row) ? "selected" : ""].join(" ").trim() || undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {cols.map((c) => {
                const v = (row as Record<string, unknown>)[c.key];
                const numeric = c.numeric ?? (!c.render && typeof v === "number");
                return (
                  <td key={c.key} className={numeric ? "num" : undefined}>
                    {c.render ? c.render(row) : formatValue(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
