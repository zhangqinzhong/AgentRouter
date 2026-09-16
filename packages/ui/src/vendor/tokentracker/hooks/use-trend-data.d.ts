export function useTrendData(options?: {
  period?: string;
  from?: string;
  to?: string;
  months?: number;
  timeZone?: string;
  tzOffsetMinutes?: number;
  now?: Date;
}): {
  rows: Array<Record<string, unknown>>;
  from?: string | null;
  to?: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
