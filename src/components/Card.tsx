export function Card({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-surface-border bg-surface-raised p-5 ${className ?? ""}`}
    >
      {title && (
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
