import type {ComponentType} from 'react';
export const DateRangePopover: ComponentType<{
  from?: string;
  to?: string;
  onApply?: (from: string, to: string) => void;
  onCancel?: () => void;
}>;
export function getDateFnsLocale(resolvedLocale: string): unknown;
export function formatDateShort(dateStr: string, locale?: unknown): string;
