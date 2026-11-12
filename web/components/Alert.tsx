export type AlertKind = "success" | "info" | "warning" | "error";

export function Alert({ kind, children }: { kind: AlertKind; children: React.ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
