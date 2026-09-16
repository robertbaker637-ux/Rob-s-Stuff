// Baker HQ status color language: green = on-track/on-budget, red =
// over-budget/off-track.

export function StatusBadge({ status, label }: { status: "good" | "bad"; label: string }) {
  const color =
    status === "good"
      ? "bg-status-good/15 text-status-good"
      : "bg-status-bad/15 text-status-bad";

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}
