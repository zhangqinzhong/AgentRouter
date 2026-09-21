import type { ComponentType, KeyboardEventHandler, ReactElement, Ref } from "react";

export type PeriodRangeOption = {
  key?: string;
  value?: string;
  label?: string;
};

export const PeriodRangeTabs: ComponentType<{
  value?: string;
  options: PeriodRangeOption[];
  onChange?: (value: string) => void;
  customKey?: string;
  customRange?: { from?: string; to?: string };
  customRangeOpen?: boolean;
  onCustomRangeOpenChange?: (open: boolean) => void;
  onCustomRangeApply?: (from: string, to: string) => void;
  activateCustomOnOpen?: boolean;
  ariaLabel?: string;
  tablistRef?: Ref<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  className?: string;
}>;
