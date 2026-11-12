"use client";

import { useState } from "react";
import { errorText, post } from "@/lib/api";
import type { EtlResult } from "@/lib/types";
import { Alert } from "./Alert";
import { useApp } from "./AppProvider";
import { Collapsible } from "./Collapsible";
import { Spinner } from "./Spinner";

/** Admin button that refreshes the Neo4j graph from MySQL for `year` (POST /etl). */
export function EtlButton({ year, onDone }: { year: string; onDone?: () => void }) {
  const { isAdmin, refreshMeta } = useApp();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EtlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!isAdmin) return null;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post<EtlResult>("/etl", { year }));
      onDone?.();
    } catch (e) {
      setError(`ETL failed: ${errorText(e)}`);
    } finally {
      setBusy(false);
      refreshMeta().catch(() => undefined);
    }
  }

  return (
    <div className="stack">
      <div>
        <button type="button" onClick={run} disabled={busy}>
          Update Neo4j graph for {year}
        </button>
      </div>
      {busy && <Spinner label="Exporting MySQL -> Neo4j ..." />}
      {error && <Alert kind="error">{error}</Alert>}
      {result && (
        <>
          {result.ok ? (
            <Alert kind="success">Neo4j graph matches MySQL.</Alert>
          ) : (
            <Alert kind="error">
              Graph does not match MySQL:
              <ul>
                {result.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          )}
          <Collapsible title="ETL log">
            <pre>{result.log.join("\n")}</pre>
          </Collapsible>
        </>
      )}
    </div>
  );
}
