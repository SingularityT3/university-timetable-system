"use client";

import { useState } from "react";
import { Alert } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { Collapsible } from "@/components/Collapsible";
import { DataTable } from "@/components/DataTable";
import { DownloadButton } from "@/components/DownloadButton";
import { EtlButton } from "@/components/EtlButton";
import { Field, OptionSelect } from "@/components/Field";
import { Metric, Metrics } from "@/components/Metric";
import { Spinner } from "@/components/Spinner";
import { errorText, post, qs } from "@/lib/api";
import { useApi, useSessionState } from "@/lib/hooks";
import type { AbsencePlan, AbsentClass, ChangeResult, CoverStatus } from "@/lib/types";

const STATUS: Record<CoverStatus, string> = {
  COVERABLE: "✅ Coverable",
  NEEDS_TEACHES: "⚠️ Needs Teaches row",
  UNCOVERED: "❌ Uncovered",
};
const PLAN_COLUMNS = ["Day", "Period", "Time", "Course", "Section", "Room", "Students", "Status", "Suggested"] as const;
type PlanRow = Record<(typeof PLAN_COLUMNS)[number], string | number>;

interface LastSubstitution extends ChangeResult {
  done: "assigned" | "undone";
}

export default function AbsentPage() {
  const { meta, year, user, refreshMeta } = useApp();
  const [fid, setFid] = useState<number | null>(user.faculty_id ?? meta.faculty[0]?.id ?? null);
  const [day, setDay] = useState("");
  const [last, setLast] = useSessionState<LastSubstitution | null>("tt_last_substitution", null);
  const plan = useApi<AbsencePlan>(fid === null ? null : qs("/absence", { faculty_id: fid, year, day }));

  function changed(r: LastSubstitution) {
    setLast(r);
    plan.reload();
    refreshMeta().catch(() => undefined);
  }

  const data = plan.data;
  const rows: PlanRow[] = (data?.classes ?? []).map((c) => ({
    Day: c.day,
    Period: c.period,
    Time: c.start_time,
    Course: `${c.course_id} ${c.course_name}`,
    Section: c.section,
    Room: c.room,
    Students: c.students,
    Status: STATUS[c.status],
    Suggested: c.substitutes[0]?.candidate ?? "-",
  }));

  return (
    <>
      <h2>Faculty absent: impact and substitutes</h2>
      <p className="muted">
        Uses the Neo4j graph. QUALIFIED = listed in Teaches for that course (can be assigned directly). RELATED = teaches
        a course sharing students/faculty with it (needs a Teaches row first). Candidates are same-department colleagues
        who are free in the slot and not marked unavailable on the Graph page.
      </p>
      <div className="columns">
        <OptionSelect label="Absent faculty member" options={meta.faculty} value={fid} onChange={setFid} />
        <Field label="Absent on">
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">Whole week</option>
            {meta.days.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </Field>
      </div>

      {last && <LastChange last={last} onChange={changed} onDismiss={() => setLast(null)} />}
      {data?.stale && (
        <>
          <Alert kind="warning">{data.stale}</Alert>
          <EtlButton year={year} onDone={plan.reload} />
        </>
      )}

      {plan.loading && <Spinner />}
      {plan.error && <Alert kind="error">{plan.error}</Alert>}
      {data && data.summary.classes_affected === 0 && (
        <Alert kind="success">This faculty member has no classes in that period; nothing is affected.</Alert>
      )}
      {data && data.summary.classes_affected > 0 && (
        <>
          <Metrics>
            <Metric label="Classes affected" value={data.summary.classes_affected} />
            <Metric label="Sections" value={data.summary.sections_affected} />
            <Metric label="Students" value={data.summary.students_affected} />
            <Metric label="Coverable" value={data.summary.coverable} />
            <Metric label="Needs Teaches row" value={data.summary.needs_teaches_row} />
            <Metric label="Uncovered" value={data.summary.uncovered} />
          </Metrics>
          <DataTable rows={rows} />
          <DownloadButton
            rows={rows}
            columns={[...PLAN_COLUMNS]}
            filename={`absence_plan_faculty${fid}_${year}.csv`}
            label="Download plan as CSV"
          />

          <h3>Substitute candidates per class</h3>
          <p className="muted small">
            Assigning hands the class to the substitute in the saved weekly timetable (every week, not just one day) and
            refreshes the Neo4j graph. You can undo it.
          </p>
          {data.classes.map((c) => (
            <Collapsible
              key={c.timetable_id}
              title={`${c.day} P${c.period}  ${c.course_id}  ${c.section}  -  ${STATUS[c.status]}`}
            >
              {c.substitutes.length === 0 ? (
                <p>Nobody in the department is free and suitable in this slot.</p>
              ) : (
                <>
                  <DataTable
                    rows={c.substitutes}
                    columns={[
                      { key: "candidate", label: "Candidate" },
                      { key: "fit", label: "Fit" },
                      { key: "related_courses", label: "Related courses taught" },
                    ]}
                  />
                  <AssignControls cls={c} onAssigned={changed} />
                </>
              )}
            </Collapsible>
          ))}
        </>
      )}
    </>
  );
}

/** Pick a candidate for one class and assign them (QUALIFIED directly; RELATED after adding Teaches). Admin only. */
function AssignControls({ cls, onAssigned }: { cls: AbsentClass; onAssigned: (r: LastSubstitution) => void }) {
  const { isAdmin } = useApp();
  const [pick, setPick] = useState(cls.substitutes[0].candidate_id);
  const [addTeaches, setAddTeaches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isAdmin) return null;

  const cand = cls.substitutes.find((s) => s.candidate_id === pick) ?? cls.substitutes[0];
  const needsTeaches = cand.fit !== "QUALIFIED";

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<ChangeResult>("/substitutions", {
        timetable_id: cls.timetable_id, faculty_id: cand.candidate_id, add_teaches: needsTeaches && addTeaches,
      });
      onAssigned({ ...r, done: "assigned" });
    } catch (e) {
      setError(`Not assigned: ${errorText(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="stack assign">
      <OptionSelect
        label="Substitute"
        options={cls.substitutes.map((s) => ({ id: s.candidate_id, label: `${s.candidate} (${s.fit})` }))}
        value={cand.candidate_id}
        onChange={(v) => {
          setPick(v);
          setAddTeaches(false);
        }}
      />
      {needsTeaches && (
        <label className="check">
          <input type="checkbox" checked={addTeaches} onChange={(e) => setAddTeaches(e.target.checked)} /> Also add{" "}
          {cand.candidate} to Teaches for {cls.course_id} (required: they are not yet listed as qualified)
        </label>
      )}
      <div>
        <button type="button" onClick={assign} disabled={busy || (needsTeaches && !addTeaches)}>
          Assign {cand.candidate} to this class
        </button>
      </div>
      {busy && <Spinner label="Updating the Neo4j graph ..." />}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}

/** Report the most recent assignment / undo, with Undo (admin, after an assignment) and Dismiss. */
function LastChange({
  last,
  onChange,
  onDismiss,
}: {
  last: LastSubstitution;
  onChange: (r: LastSubstitution) => void;
  onDismiss: () => void;
}) {
  const { meta, isAdmin } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ch = last.change;
  const slot = meta.slots.find((s) => s.id === ch.slot_id);
  const what = `${ch.course_id} (section ${ch.section_id}, ${slot ? `${slot.day_of_week} P${slot.period_no}` : `slot ${ch.slot_id}`}, ${ch.academic_year})`;

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<ChangeResult>("/substitutions/undo", { change: ch });
      onChange({ ...r, done: "undone" });
    } catch (e) {
      setError(`Could not undo: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {last.done === "assigned" ? (
        <Alert kind="success">
          {what} now taught by <strong>{ch.new_faculty}</strong> instead of {ch.old_faculty}.
          {ch.teaches_added && ` Added ${ch.new_faculty} to Teaches for ${ch.course_id}.`}
        </Alert>
      ) : (
        <Alert kind="info">
          Undone: {what} is taught by <strong>{ch.new_faculty}</strong> again.
        </Alert>
      )}
      {last.graph_problem && <Alert kind="warning">{last.graph_problem}</Alert>}
      <div className="row">
        {last.done === "assigned" && isAdmin && (
          <button type="button" onClick={undo} disabled={busy}>
            Undo
          </button>
        )}
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {busy && <Spinner label="Updating the Neo4j graph ..." />}
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  );
}
