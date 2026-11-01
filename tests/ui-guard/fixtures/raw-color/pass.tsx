// Tokens only. Comments may mention #007aff or rgb(0 0 0) freely.
/* Block comments too: #ffffff */
export const chartColors = { input: "var(--data-input)", output: "var(--data-output)" };
export const anchors = ["#root", "#settings-panel", "issue-#12"];
export function Swatch() {
  return <span className="bg-muted text-brand-ink" style={{ color: "var(--status-ok)" }} />;
}
