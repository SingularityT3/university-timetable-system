"use client";

import { useState } from "react";
import { Alert } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { DataTable } from "@/components/DataTable";
import { Field, OptionSelect } from "@/components/Field";
import { Metric, Metrics } from "@/components/Metric";
import { Spinner } from "@/components/Spinner";
import { api, errorText, post, qs } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { CheckResult, ClashReport, Ripple, SectionClass } from "@/lib/types";

const TABS = ["Saved timetable", "Check a proposed class", "Move a class (ripple)"] as const;

export default function ClashesPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  return (
    <>
      <h2>Clash checker</h2>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="stack">
        {tab === TABS[0] && <SavedTab />}
        {tab === TABS[1] && <ProposalTab />}
        {tab === TABS[2] && <RippleTab />}
      </div>
    </>
  );
}

function SavedTab() {
  const { year } = useApp();
  const { data, error, loading } = useApi<ClashReport>(qs("/clashes", { year }));
  if (loading) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;
  if (data.classes === 0) return <Alert kind="info">No timetable saved for {year}.</Alert>;
  return (
    <>
      <Metrics>
        <Metric label="Classes saved" value={data.classes} />
        <Metric label="Clashes / rule violations" value={data.clashes.length} />
        <Metric label="Sections short of hours" value={data.gaps.length} />
      </Metrics>
      {data.clashes.length > 0 ? (
        <>
          <Alert kind="error">Rule violations found:</Alert>
          <DataTable rows={data.clashes} />
        </>
      ) : (
        <Alert kind="success">
          No clashes: no room, faculty or section is double-booked, every room fits its course type and size, and every
          faculty member is qualified.
        </Alert>
      )}
      {data.gaps.length > 0 ? (
        <>
          <Alert kind="warning">Some courses do not have exactly their weekly hours scheduled:</Alert>
          <DataTable rows={data.gaps} />
        </>
      ) : (
        <Alert kind="success">Every (section, course) has exactly its required weekly hours.</Alert>
      )}
      <p className="muted small">Runs the stored procedures sp_list_clashes and sp_hours_coverage.</p>
    </>
  );
}

function ProposalTab() {
  const { meta, year } = useApp();
  const [section, setSection] = useState(meta.sections[0]?.id ?? null);
  const [course, setCourse] = useState(meta.courses[0]?.id ?? null);
  const [faculty, setFaculty] = useState(meta.faculty[0]?.id ?? null);
  const [room, setRoom] = useState(meta.rooms[0]?.id ?? null);
  const [slot, setSlot] = useState(meta.slots[0]?.id ?? null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await post<CheckResult>("/clashes/check", {
        year, section_id: section, course_id: course, faculty_id: faculty, room_id: room, slot_id: slot,
      }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">
        Test a class without saving it: every rule MySQL enforces is checked, plus the weekly-hours rule.
      </p>
      <div className="columns three">
        <OptionSelect label="Section" options={meta.sections} value={section} onChange={setSection} />
        <OptionSelect label="Course" options={meta.courses} value={course} onChange={setCourse} />
        <OptionSelect
          label="Faculty"
          options={meta.faculty.map((f) => ({ id: f.id, label: f.name }))}
          value={faculty}
          onChange={setFaculty}
        />
      </div>
      <div className="columns">
        <OptionSelect label="Room" options={meta.rooms} value={room} onChange={setRoom} />
        <OptionSelect label="Slot" options={meta.slots} value={slot} onChange={setSlot} />
      </div>
      <div>
        <button type="button" onClick={check} disabled={busy}>
          Check this class
        </button>
      </div>
      {busy && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {result && (
        <>
          {result.accepted ? (
            <Alert kind="success">MySQL would accept this class.</Alert>
          ) : (
            <Alert kind="error">MySQL would REJECT this class ({result.hard_broken} hard rule(s) broken).</Alert>
          )}
          <ul className="rules">
            {result.results.map((r) => (
              <li key={r.rule}>
                {r.ok ? "✅" : r.hard ? "❌" : "⚠️"} <strong>{r.rule}</strong>: {r.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function RippleTab() {
  const { meta, year } = useApp();
  const [section, setSection] = useState(meta.sections[0]?.id ?? null);
  const [picked, setPicked] = useState<number | null>(null);
  const [day, setDay] = useState<string>(meta.days[0]);
  const [period, setPeriod] = useState(1);
  const [result, setResult] = useState<Ripple | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const classes = useApi<SectionClass[]>(section === null ? null : qs(`/sections/${section}/classes`, { year }));
  const periods = [...new Set(meta.slots.map((s) => s.period_no))].sort((a, b) => a - b);

  const list = classes.data ?? [];
  const tid = list.some((c) => c.timetable_id === picked) ? picked : (list[0]?.timetable_id ?? null);

  async function show() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<Ripple>(qs("/ripple", { timetable_id: tid, day, period })));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted">
        Uses Neo4j: if you move a class to another slot (keeping faculty, section and room), which existing classes
        collide and how many students are displaced?
      </p>
      <OptionSelect
        label="Section whose class you want to move"
        options={meta.sections}
        value={section}
        onChange={(v) => {
          setSection(v);
          setResult(null);
        }}
      />
      {classes.loading && <Spinner />}
      {classes.error && <Alert kind="error">{classes.error}</Alert>}
      {classes.data && list.length === 0 && (
        <Alert kind="info">This section has no classes saved for the selected year.</Alert>
      )}
      {list.length > 0 && (
        <>
          <OptionSelect
            label="Class to move"
            options={list.map((c) => ({
              id: c.timetable_id,
              label: `${c.day_of_week} P${c.period_no}  ${c.course_id}  (${c.faculty})`,
            }))}
            value={tid}
            onChange={setPicked}
          />
          <div className="columns">
            <Field label="Move to day">
              <select value={day} onChange={(e) => setDay(e.target.value)}>
                {meta.days.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
            <Field label="Move to period">
              <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                {periods.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div>
            <button type="button" onClick={show} disabled={busy || tid === null}>
              Show the ripple effect
            </button>
          </div>
        </>
      )}
      {busy && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {result && <RippleResult r={result} />}
    </>
  );
}

function RippleResult({ r }: { r: Ripple }) {
  const mv = r.moved;
  return (
    <>
      <p>
        Moving <strong>{mv.moved_course}</strong> ({mv.moved_section}) from {mv.from_day} P{mv.from_period} to{" "}
        {mv.to_day} P{mv.to_period}:
      </p>
      {r.free_move ? (
        <Alert kind="success">Free move: nothing in the target slot collides with it.</Alert>
      ) : (
        <>
          <Alert kind="error">
            {r.clashes.length} existing class(es) collide; {r.students_displaced} students would be displaced. Each of
            these classes would have to move too.
          </Alert>
          <DataTable
            rows={r.clashes}
            columns={[
              { key: "clash_course", label: "Course" },
              { key: "clash_section", label: "Section" },
              { key: "clash_faculty", label: "Faculty" },
              { key: "clash_room", label: "Room" },
              { key: "clash_types", label: "Clash on" },
              { key: "students_displaced", label: "Students" },
            ]}
          />
        </>
      )}
    </>
  );
}
