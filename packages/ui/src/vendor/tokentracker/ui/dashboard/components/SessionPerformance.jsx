import React from "react";
import { copy } from "../../../lib/copy";

export function SessionPerformance({ performance, className = "" }) {
  const speed = Number(performance?.estimated_tokens_per_second);
  const count = Number(performance?.estimated_request_count || 0);
  if (!Number.isFinite(speed) || speed <= 0 || count <= 0) return null;
  return (
    <span
      className={className}
      title={`${copy("sessions.performance.samples", { count })}\n${copy("sessions.performance.method")}`}
    >
      {copy("sessions.performance.speed", { speed: Number(speed.toFixed(1)) })}
    </span>
  );
}
