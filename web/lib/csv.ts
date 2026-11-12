/** CSV helpers (replace pandas' to_csv): RFC 4180 quoting, "\r\n" line ends. */

type Cell = string | number | boolean | null | undefined;

function quote(value: Cell): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T extends object>(rows: T[], columns: (keyof T & string)[]): string {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) lines.push(columns.map((c) => quote(row[c] as Cell)).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
