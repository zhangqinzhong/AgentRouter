import type { KeyboardEventHandler, ReactElement, Ref } from "react";

export type PeriodRangeOption<T extends string = string> = {
  label?: string;
} & ({ key: T; value?: T } | { key?: T; value: T });

export function PeriodRangeTabs<T extends string>(props: {
  value?: T;
  options: PeriodRangeOption<T>[];
  onChange?: (value: T) => void;
  customKey?: T;
  customRange?: { from?: string; to?: string };
  customRangeOpen?: boolean;
  onCustomRangeOpenChange?: (open: boolean) => void;
  onCustomRangeApply?: (from: string, to: string) => void;
  ariaLabel?: string;
  tablistRef?: Ref<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  className?: string;
}): ReactElement;
