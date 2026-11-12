"use client";

import { useState } from "react";
import { Alert } from "@/components/Alert";
import { Field } from "@/components/Field";
import { errorText, post } from "@/lib/api";
import { go } from "@/lib/nav";

/** Only same-site paths are allowed as a post-login target. */
function nextTarget(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/timetable";
}

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { username, password });
      go(nextTarget());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1>🗓️ Timetable System</h1>
        <p className="muted">Sign in to continue.</p>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in ..." : "Sign in"}
        </button>
        <p className="muted small">
          Demo accounts: <code>admin / admin123</code> (admin), <code>faculty1 / faculty123</code> and{" "}
          <code>faculty2 / faculty123</code> (faculty, read-only).
        </p>
      </form>
    </main>
  );
}
