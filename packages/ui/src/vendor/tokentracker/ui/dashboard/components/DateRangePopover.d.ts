import type {ComponentType, ReactElement} from 'react';
export const DateRangePickerPopover: ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from?: string;
  to?: string;
  onApply?: (from: string, to: string) => void;
  label?: string;
  active?: boolean;
  trigger?: ReactElement;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
}>;
export const DateRangePopover: ComponentType<{
  from?: string;
  to?: string;
  onApply?: (from: string, to: string) => void;
  onCancel?: () => void;
}>;
export function getDateFnsLocale(resolvedLocale: string): unknown;
export function formatDateShort(dateStr: string, locale?: unknown): string;
