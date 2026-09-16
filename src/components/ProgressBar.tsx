export function ProgressBar({
  value,
  max,
  status = "good",
}: {
  value: number;
  max: number;
  status?: "good" | "bad";
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const barColor = status === "bad" ? "bg-status-bad" : "bg-status-good";

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-border">
      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
