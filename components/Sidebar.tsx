"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { go } from "@/lib/nav";
import { useApp } from "./AppProvider";

export const NAV = [
  { href: "/timetable", label: "Timetable" },
  { href: "/generator", label: "Run generator", adminOnly: true },
  { href: "/absent", label: "Faculty absent" },
  { href: "/clashes", label: "Clash checker" },
  { href: "/statistics", label: "Statistics" },
  { href: "/graph", label: "Graph (Neo4j)" },
];

export function Sidebar() {
  const { user, meta, year, setYear, isAdmin } = useApp();
  const pathname = usePathname();

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    go("/login");
  }

  return (
    <aside className="sidebar">
      <h1 className="app-title">🗓️ Timetable System</h1>
      <label className="field">
        <span className="field-label">Academic year</span>
        <select value={year} onChange={(e) => setYear(e.target.value)}>
          {meta.years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </label>
      <nav aria-label="Pages">
        {NAV.filter((n) => isAdmin || !n.adminOnly).map((n) => (
          <Link key={n.href} href={n.href} className={pathname === n.href ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <hr />
      <div className="user-box">
        <span>{user.faculty_name ?? user.username}</span>
        <span className={`badge badge-${user.role}`}>{user.role}</span>
        <button type="button" className="link-button" onClick={logout}>
          Logout
        </button>
      </div>
      <div className="captions">
        <p>MySQL: connected</p>
        <p>{meta.neo4j.ok ? "Neo4j: connected" : `Neo4j: unavailable (${meta.neo4j.detail})`}</p>
        <p>
          {meta.counts[year] ?? 0} classes saved for {year}
        </p>
      </div>
    </aside>
  );
}
