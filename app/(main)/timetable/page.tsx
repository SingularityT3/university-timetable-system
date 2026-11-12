"use client";

import { useState } from "react";
import { Alert } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { DownloadButton } from "@/components/DownloadButton";
import { OptionSelect } from "@/components/Field";
import { FreeBlocks } from "@/components/FreeBlocks";
import { Metric, Metrics } from "@/components/Metric";
import { Spinner } from "@/components/Spinner";
import { WeekGrid } from "@/components/WeekGrid";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { TimetableResponse, TimetableRow } from "@/lib/types";

type View = "section" | "faculty" | "room";
const VIEWS: { id: View; label: string }[] = [
  { id: "section", label: "Section" },
  { id: "faculty", label: "Faculty" },
  { id: "room", label: "Room" },
];
const CSV_COLUMNS: (keyof TimetableRow)[] = [
  "day_of_week", "period_no", "start_time", "end_time", "course_id", "course_name",
  "faculty_name", "dept_name", "semester", "section_name", "building", "room_no",
];

export default function TimetablePage() {
  const { meta, year, user } = useApp();
  const mine = user.role === "faculty" ? user.faculty_id : null;
  const [view, setView] = useState<View>(mine ? "faculty" : "section");
  const [picked, setPicked] = useState<Partial<Record<View, number>>>(mine ? { faculty: mine } : {});

  const options = { section: meta.sections, faculty: meta.faculty, room: meta.rooms }[view];
  const id = picked[view] ?? options[0]?.id ?? null;
  const label = VIEWS.find((v) => v.id === view)!.label;
  const { data, error, loading } = useApi<TimetableResponse>(id === null ? null : qs("/timetable", { year, view, id }));

  return (
    <>
      <h2>Weekly timetable</h2>
      <div className="row">
        <fieldset className="radio-group">
          <legend>View by</legend>
          {VIEWS.map((v) => (
            <label key={v.id}>
              <input type="radio" name="view" checked={view === v.id} onChange={() => setView(v.id)} /> {v.label}
            </label>
          ))}
        </fieldset>
        <OptionSelect label={label} options={options} value={id} onChange={(v) => setPicked({ ...picked, [view]: v })} />
      </div>

      {loading && <Spinner />}
      {error && <Alert kind="error">{error}</Alert>}
      {data && (
        <>
          <WeekGrid grid={data.grid} />
          <p className="muted small legend">
            <span className="swatch theory" /> theory <span className="swatch lab" /> lab | lunch is shown as its own row
          </p>
          <Metrics>
            <Metric label="Periods per week" value={data.metrics.periods} />
            <Metric label="Distinct courses" value={data.metrics.courses} />
            <Metric label="Days with classes" value={data.metrics.days} />
          </Metrics>
          {data.rows.length === 0 ? (
            <Alert kind="info">
              No classes saved for {year}. Use <strong>Run generator</strong> to create a timetable.
            </Alert>
          ) : (
            <DownloadButton rows={data.rows} columns={CSV_COLUMNS} filename={`timetable_${view}_${id}_${year}.csv`} />
          )}
        </>
      )}
      {id !== null && view !== "section" && <FreeBlocks year={year} kind={view === "faculty" ? "FACULTY" : "ROOM"} id={id} />}
    </>
  );
}
