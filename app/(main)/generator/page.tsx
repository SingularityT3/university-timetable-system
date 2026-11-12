"use client";

import { useState } from "react";
import { Alert, type AlertKind } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { Collapsible } from "@/components/Collapsible";
import { DataTable } from "@/components/DataTable";
import { EtlButton } from "@/components/EtlButton";
import { Field } from "@/components/Field";
import { Metric, Metrics } from "@/components/Metric";
import { Spinner } from "@/components/Spinner";
import { errorText, post } from "@/lib/api";
import { useSessionState } from "@/lib/hooks";
import type { GenResult } from "@/lib/types";

function banner(res: GenResult): { kind: AlertKind; text: string } {
  const kind: AlertKind = res.error ? "error" : res.complete ? "success" : "warning";
  const tail = res.committed ? " and saved to MySQL." : res.note ? `. Not saved: ${res.note}` : ".";
  return { kind, text: `${res.status}: ${res.placed} of ${res.required} periods placed${tail}` };
}

export default function GeneratorPage() {
  const { meta, year: selectedYear, isAdmin, refreshMeta } = useApp();
  const [year, setYear] = useState(selectedYear);
  const [replace, setReplace] = useState(false);
  const [partial, setPartial] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [limit, setLimit] = useState(30);
  const [seed, setSeed] = useState(42);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useSessionState<GenResult | null>("tt_gen_result", null);

  if (!isAdmin) return <Alert kind="warning">Only administrators can run the generator.</Alert>;
  const existing = meta.counts[year] ?? 0;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<GenResult>("/generator", {
        year: year.trim(), replace, allow_partial: partial, dry_run: dryRun, time_limit: limit, seed,
      });
      setRes(r);
      if (r.committed) await refreshMeta();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const b = res && banner(res);
  return (
    <>
      <h2>Run the timetable generator</h2>
      <p className="muted">
        Greedy most-constrained-first search with backtracking. All hard constraints are enforced; soft ones are best
        effort. Everything is saved in one transaction.
      </p>
      <div className="narrow">
        <Field label="Academic year">
          <input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{4}" />
        </Field>
      </div>
      {existing > 0 && (
        <Alert kind="warning">
          {year} already has {existing} classes. Tick <strong>Replace</strong> to overwrite them.
        </Alert>
      )}
      <div className="columns">
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing
            timetable
          </label>
          <label className="check">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} /> Save a partial
            timetable if a complete one is impossible
          </label>
        </div>
        <div className="stack">
          <label className="check">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry run (compute and
            report only)
          </label>
          <Field label={`Search time limit (seconds): ${limit}`}>
            <input type="range" min={5} max={120} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </Field>
          <Field label="Random seed">
            <input type="number" step={1} value={seed} onChange={(e) => setSeed(Math.trunc(Number(e.target.value)))} />
          </Field>
        </div>
      </div>
      <div>
        <button type="button" className="primary" onClick={generate} disabled={busy || !year.trim()}>
          Generate timetable
        </button>
      </div>
      {busy && <Spinner label="Searching for a clash-free timetable ..." />}
      {error && <Alert kind="error">{error}</Alert>}

      {res && b && (
        <section className="stack">
          <Alert kind={b.kind}>{b.text}</Alert>
          <Metrics>
            <Metric label="Periods placed" value={`${res.placed}/${res.required}`} />
            <Metric label="Search nodes" value={res.nodes} />
            <Metric label="Time (s)" value={res.elapsed.toFixed(2)} />
            <Metric label="Restarts used" value={res.attempts} />
          </Metrics>
          {"same_day_repeats" in res.soft && (
            <Metrics>
              <Metric label="Same course twice a day" value={res.soft.same_day_repeats} />
              <Metric label={`Faculty runs > ${res.max_fac_consec} periods`} value={res.soft.faculty_long_runs} />
              <Metric label="Lab blocks split" value={res.soft.lab_blocks_split} />
            </Metrics>
          )}
          {res.preflight.length > 0 && (
            <Alert kind="error">
              The input data makes a timetable impossible:
              <ul>
                {res.preflight.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          )}
          {res.unplaced.length > 0 && (
            <>
              <h3>Could not be placed</h3>
              <DataTable rows={res.unplaced} />
            </>
          )}
          <Collapsible title="Full report">
            <pre>{res.report}</pre>
          </Collapsible>
          {res.committed && (
            <>
              <Alert kind="info">
                The Neo4j graph is now out of date. Refresh it so the <em>Faculty absent</em> tool sees this timetable.
              </Alert>
              <EtlButton year={res.academic_year} />
            </>
          )}
        </section>
      )}
    </>
  );
}
