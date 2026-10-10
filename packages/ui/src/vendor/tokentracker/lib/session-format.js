import { copy } from "./copy";

// `timeOnly` is for rows already sitting under a date heading, where repeating
// the day on every line is noise.
export function formatWhen(value, locale, { timeOnly = false } = {}) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  const options = timeOnly
    ? { hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try {
    return new Date(ms).toLocaleString(locale || undefined, options);
  } catch {
    const iso = new Date(ms).toISOString();
    return timeOnly ? iso.slice(11, 16) : iso.slice(0, 16).replace("T", " ");
  }
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const totalMinutes = Math.round(n / 60000);
  if (totalMinutes < 60) return copy("sessions.duration.minutes", { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return copy("sessions.duration.hours", { hours, minutes });
}
