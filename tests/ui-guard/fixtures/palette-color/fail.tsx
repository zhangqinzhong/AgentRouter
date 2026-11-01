// Expected: 4 palette-color violations.
export function Badge() {
  return <span className="bg-emerald-500 text-emerald-600 dark:text-emerald-400 border-l-amber-300">ok</span>;
}
