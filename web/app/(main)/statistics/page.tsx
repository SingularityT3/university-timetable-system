"use client";

import { Alert } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { BarChart } from "@/components/BarChart";
import { Collapsible } from "@/components/Collapsible";
import { DataTable } from "@/components/DataTable";
import { Metric, Metrics } from "@/components/Metric";
import { Spinner } from "@/components/Spinner";
import { qs } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { Stats } from "@/lib/types";

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** sections x days table of periods per day (0 where a section has no class that day). */
function pivot(load: Stats["section_load"], days: string[]) {
  const bySection = new Map<string, Record<string, string | number>>();
  for (const { section, day, n } of load) {
    const row = bySection.get(section) ?? { section, ...Object.fromEntries(days.map((d) => [d, 0])) };
    row[day] = n;
    bySection.set(section, row);
  }
  return [...bySection.values()]; // API order: department, semester, section
}

export default function StatisticsPage() {
  const { year, meta } = useApp();
  const { data, error, loading } = useApi<Stats>(qs("/stats", { year }));
  if (loading) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return null;

  return (
    <>
      <h2>Statistics</h2>
      {data.classes === 0 ? <Alert kind="info">No timetable saved for {year}.</Alert> : <Charts s={data} days={meta.days} />}
    </>
  );
}

function Charts({ s, days }: { s: Stats; days: string[] }) {
  const loads = s.workload.map((w) => w.periods_per_week);
  const usedDays = days.filter((d) => s.section_load.some((l) => l.day === d));
  const rooms = [...s.rooms].sort((a, b) => b.utilization_pct - a.utilization_pct).slice(0, 15);
  return (
    <>
      <Metrics>
        <Metric label="Classes per week" value={s.classes} />
        <Metric label="Faculty teaching" value={loads.filter((n) => n > 0).length} />
        <Metric label="Avg faculty load" value={`${mean(loads).toFixed(1)} periods`} />
        <Metric label="Rooms in use" value={`${s.rooms.filter((r) => r.used_slots > 0).length}/${s.rooms.length}`} />
        <Metric label="Avg room utilisation" value={`${mean(s.rooms.map((r) => r.utilization_pct)).toFixed(1)}%`} />
      </Metrics>

      <div className="columns wide">
        <section>
          <h3>Faculty workload (periods per week)</h3>
          <BarChart data={s.workload.map((w) => ({ label: w.faculty_name, value: w.periods_per_week }))} />
        </section>
        <section>
          <h3>Room utilisation (% of {s.rooms[0]?.total_slots ?? 48} slots)</h3>
          <BarChart data={rooms.map((r) => ({ label: `${r.building} ${r.room_no}`, value: r.utilization_pct }))} unit="%" />
        </section>
        <section>
          <h3>Classes per day</h3>
          <BarChart data={s.by_day.map((d) => ({ label: d.day, value: d.classes }))} />
        </section>
        <section>
          <h3>Classes per period</h3>
          <BarChart data={s.by_period.map((p) => ({ label: `P${p.period}`, value: p.classes }))} />
        </section>
        <section>
          <h3>Theory vs lab periods</h3>
          <BarChart data={s.kinds.map((k) => ({ label: k.type, value: k.classes }))} />
        </section>
        <section>
          <h3>Section load: periods per day</h3>
          <DataTable
            rows={pivot(s.section_load, usedDays)}
            columns={[{ key: "section", label: "Section" }, ...usedDays.map((d) => ({ key: d }))]}
          />
        </section>
      </div>

      <section>
        <h3>Department summary</h3>
        <p className="muted small">
          Stored procedure <code>sp_department_summary</code>: common table expressions built on the stored function{" "}
          <code>fn_faculty_load</code> (periods per week of one teacher).
        </p>
        <DataTable rows={s.departments} />
      </section>

      <Collapsible title="Graph insights (Neo4j)">
        {"error" in s.graph ? (
          <Alert kind="info">{s.graph.error}</Alert>
        ) : (
          <>
            <p>Courses colliding with the most others (shared faculty + shared students):</p>
            <BarChart data={s.graph.conflicted.map((c) => ({ label: c.course_id, value: c.total_shared_count }))} />
            {s.graph.bridges.length > 0 && (
              <>
                <p>Cross-department teaching links:</p>
                <DataTable rows={s.graph.bridges} />
              </>
            )}
          </>
        )}
      </Collapsible>
    </>
  );
}

