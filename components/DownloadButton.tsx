"use client";

import { downloadCsv, toCsv } from "@/lib/csv";

export function DownloadButton<T extends object>({
  rows,
  columns,
  filename,
  label = "Download as CSV",
}: {
  rows: T[];
  columns: (keyof T & string)[];
  filename: string;
  label?: string;
}) {
  return (
    <button type="button" onClick={() => downloadCsv(filename, toCsv(rows, columns))}>
      ⬇ {label}
    </button>
  );
}
