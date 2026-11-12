export function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

export function Metrics({ children }: { children: React.ReactNode }) {
  return <div className="metrics">{children}</div>;
}
