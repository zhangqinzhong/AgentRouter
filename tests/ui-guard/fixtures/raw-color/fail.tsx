// Expected: 5 raw-color violations.
export const chartColors = { input: "#007aff", output: "#34C759" };
export function Swatch() {
  return <span className="bg-[#fafafa]" style={{ color: "rgba(0, 0, 0, 0.5)", borderColor: "oklch(70% 0.1 160)" }} />;
}
