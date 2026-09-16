import type {ComponentType} from 'react';
export const TrendMonitor: ComponentType<{
  rows?: unknown[];
  from?: string | null;
  to?: string | null;
  period?: string;
  timeZoneLabel?: string;
  showTimeZoneLabel?: boolean;
  className?: string;
  embedded?: boolean;
  chartHeightClass?: string;
  isZoom?: boolean;
  zoomConfig?: Record<string, unknown> | null;
}>;
export function getTrendMonitorScale(values: unknown[]): {rawMax: number; effectiveMax: number; clippedValues: number[]};
export function mergeModelSegments(models: unknown): Array<{type: string; name: string; value: number}>;
export function getModelColor(modelName: string): string;
