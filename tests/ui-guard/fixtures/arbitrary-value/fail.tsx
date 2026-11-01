// Expected: 6 arbitrary-value violations.
export function Card({ pct }: { pct: number }) {
  return (
    <div className="max-w-[1120px] rounded-[10px] bg-emerald-500/[0.045] [mask-type:luminance]">
      <span className={`w-[${pct}%] sm:min-h-[36px]`} />
    </div>
  );
}
