"use client";

import { useState } from "react";
import { Alert } from "@/components/Alert";
import { useApp } from "@/components/AppProvider";
import { DataTable } from "@/components/DataTable";
import { Field, OptionSelect } from "@/components/Field";
import { Spinner } from "@/components/Spinner";
import { api, errorText, qs } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { GraphNode, Neighbour, Unavailability } from "@/lib/types";

const LABELS = ["Department", "Faculty", "Course", "Section", "Student", "Classroom", "TimeSlot"];

export default function GraphPage() {
  return (
    <>
      <h2>Graph (Neo4j)</h2>
      <p className="muted">
        Browse the Neo4j graph that the ETL builds from MySQL, and keep faculty unavailability marks, which live only in
        Neo4j.
      </p>
      <NodeBrowser />
      <UnavailabilityPanel />
    </>
  );
}

function NodeBrowser() {
  const [label, setLabel] = useState("Faculty");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(25);
  const [node, setNode] = useState<{ label: string; key: string | number; name: string } | null>(null);
  const nodes = useApi<GraphNode[]>(qs("/graph/nodes", { label, search: search.trim(), limit }));
  const neighbours = useApi<Neighbour[]>(node && qs("/graph/neighbours", { label: node.label, key: node.key }));

  return (
    <section className="panel">
      <h3>Node browser</h3>
      <div className="columns three">
        <Field label="Label">
          <select
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setNode(null);
            }}
          >
            {LABELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Search (id or name)">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Field label="Show at most">
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
      </div>
      {nodes.error && <Alert kind="error">{nodes.error}</Alert>}
      {nodes.loading && !nodes.data && <Spinner />}
      {nodes.data && (
        <DataTable
          rows={nodes.data}
          empty="No matching nodes."
          caption="Click a row to see its neighbours."
          columns={[
            { key: "id", label: "Key" },
            { key: "name", label: "Name" },
            { key: "degree", label: "Relationships" },
            { key: "properties", label: "Properties", render: (n) => <PropList props={n.properties} /> },
          ]}
          onRowClick={(n) => setNode({ label, key: n.id, name: n.name })}
          isSelected={(n) => node?.label === label && node.key === n.id}
        />
      )}

      {node && (
        <div className="stack">
          <h4>
            Neighbours of {node.label} {node.name} ({String(node.key)})
          </h4>
          {neighbours.loading && <Spinner />}
          {neighbours.error && <Alert kind="error">{neighbours.error}</Alert>}
          {neighbours.data && (
            <DataTable
              rows={neighbours.data}
              empty="This node has no relationships."
              caption="Click a neighbour to open it."
              columns={[
                { key: "relationship", label: "Relationship" },
                { key: "direction", label: "Direction", render: (r) => (r.direction === "OUT" ? "→ out" : "← in") },
                { key: "label", label: "Label" },
                { key: "key", label: "Key" },
                { key: "name", label: "Name" },
                { key: "properties", label: "Properties", render: (r) => <PropList props={r.properties} /> },
              ]}
              onRowClick={(r) => setNode({ label: r.label, key: r.key, name: r.name })}
            />
          )}
        </div>
      )}
    </section>
  );
}

function PropList({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props ?? {});
  if (entries.length === 0) return <span className="muted">-</span>;
  return (
    <span className="props">
      {entries.map(([k, v]) => (
        <span key={k}>
          <code>{k}</code>: {typeof v === "object" ? JSON.stringify(v) : String(v)}
        </span>
      ))}
    </span>
  );
}

function UnavailabilityPanel() {
  const { meta, user, isAdmin } = useApp();
  const [fid, setFid] = useState<number>(user.faculty_id ?? meta.faculty[0]?.id ?? 0);
  const [slot, setSlot] = useState(meta.slots[0]?.id ?? 0);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ slot_id: number; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const marks = useApi<Unavailability[]>(qs("/graph/unavailability", { faculty_id: fid }));
  const name = meta.faculty.find((f) => f.id === fid)?.name ?? `faculty ${fid}`;

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      await action();
      setMsg({ kind: "success", text: done });
      setEditing(null);
      marks.reload();
      return true;
    } catch (e) {
      setMsg({ kind: "error", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const save = (slot_id: number, why: string) =>
    run(
      () => api("/graph/unavailability", { method: "PUT", body: JSON.stringify({ faculty_id: fid, slot_id, reason: why.trim() }) }),
      `Saved: ${name} is unavailable in ${meta.slots.find((s) => s.id === slot_id)?.label ?? `slot ${slot_id}`}.`,
    );
  const remove = (m: Unavailability) =>
    run(
      () => api(qs("/graph/unavailability", { faculty_id: m.faculty_id, slot_id: m.slot_id }), { method: "DELETE" }),
      `Removed the mark for ${m.day} P${m.period}.`,
    );

  return (
    <section className="panel">
      <h3>Faculty unavailability</h3>
      <p className="muted small">
        A mark is an <code>UNAVAILABLE_AT</code> relationship from a Faculty node to a TimeSlot node, with a reason. The
        substitute finder on the <em>Faculty absent</em> page skips teachers who are marked unavailable in the class&apos;s
        slot. Marks are kept when the graph is refreshed from MySQL.
      </p>
      <OptionSelect label="Faculty member" options={meta.faculty} value={fid} onChange={setFid} />
      {marks.loading && !marks.data && <Spinner />}
      {marks.error && <Alert kind="error">{marks.error}</Alert>}
      {marks.data && (
        <DataTable
          rows={marks.data}
          empty={`${name} has no unavailability marks.`}
          columns={[
            { key: "day", label: "Day" },
            { key: "period", label: "Period", render: (m) => `P${m.period}` },
            { key: "start_time", label: "Time", render: (m) => `${m.start_time} - ${m.end_time}` },
            {
              key: "reason",
              label: "Reason",
              render: (m) =>
                editing?.slot_id === m.slot_id ? (
                  <input
                    aria-label="New reason"
                    value={editing.reason}
                    maxLength={200}
                    onChange={(e) => setEditing({ slot_id: m.slot_id, reason: e.target.value })}
                  />
                ) : (
                  m.reason
                ),
            },
            { key: "updated_at", label: "Updated", render: (m) => m.updated_at?.replace("T", " ").slice(0, 19) },
            ...(isAdmin
              ? [
                  {
                    key: "actions",
                    label: "",
                    render: (m: Unavailability) =>
                      editing?.slot_id === m.slot_id ? (
                        <span className="row">
                          <button type="button" disabled={busy || !editing.reason.trim()} onClick={() => save(m.slot_id, editing.reason)}>
                            Save
                          </button>
                          <button type="button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="row">
                          <button type="button" onClick={() => setEditing({ slot_id: m.slot_id, reason: m.reason ?? "" })}>
                            Edit reason
                          </button>
                          <button type="button" className="danger" disabled={busy} onClick={() => remove(m)}>
                            Delete
                          </button>
                        </span>
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      {isAdmin ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            save(slot, reason).then((ok) => ok && setReason(""));
          }}
        >
          <h4>Mark {name} unavailable</h4>
          <div className="columns">
            <OptionSelect label="Slot" options={meta.slots} value={slot} onChange={setSlot} />
            <Field label="Reason">
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required />
            </Field>
          </div>
          <p className="muted small">Saving a slot that is already marked updates its reason.</p>
          <div>
            <button type="submit" className="primary" disabled={busy || !reason.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small">Only administrators can add, edit or delete marks.</p>
      )}
    </section>
  );
}
