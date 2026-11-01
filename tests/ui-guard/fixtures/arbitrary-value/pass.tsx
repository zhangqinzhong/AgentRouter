// Token utilities; arbitrary *variants* select state and are allowed.
type Row = { [key: string]: number };
export function Card({ rows }: { rows: Row[] }) {
  const first = rows[0];
  return (
    <div className="max-w-page rounded-md bg-brand-soft text-body data-[state=open]:bg-muted [&_svg]:size-4 group-hover:opacity-80">
      <span style={{ width: `${first?.value ?? 0}%` }} />
    </div>
  );
}
