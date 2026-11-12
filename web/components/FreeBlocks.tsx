"use client";

import { qs } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { FreeBlock } from "@/lib/types";
import { Alert } from "./Alert";
import { DataTable } from "./DataTable";
import { Spinner } from "./Spinner";

/** Maximal runs of consecutive free periods (stored procedure sp_free_blocks, a recursive CTE). */
export function FreeBlocks({ year, kind, id }: { year: string; kind: "FACULTY" | "ROOM"; id: number }) {
  const { data, error, loading } = useApi<FreeBlock[]>(qs("/free-blocks", { year, kind, id }));
  return (
    <section className="panel">
      <h3>Free blocks</h3>
      <p className="muted small">
        Longest runs of back-to-back free periods per day (lunch breaks a run). Computed in MySQL by the stored
        procedure <code>sp_free_blocks</code>, which uses a recursive CTE.
      </p>
      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <DataTable
          rows={data}
          empty="No free periods."
          columns={[
            { key: "day_of_week", label: "Day" },
            { key: "start_period", label: "From", render: (r) => `P${r.start_period}` },
            { key: "end_period", label: "To", render: (r) => `P${r.end_period}` },
            { key: "start_time", label: "Starts" },
            { key: "end_time", label: "Ends" },
            { key: "length", label: "Periods" },
          ]}
        />
      )}
    </section>
  );
}
