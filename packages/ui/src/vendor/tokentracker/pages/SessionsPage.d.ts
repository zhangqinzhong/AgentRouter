import type {ComponentType} from 'react';
export const SessionsPage: ComponentType<{defaultRange?: "all" | "7d" | "30d" | "90d"}>;

export function sessionQueryRange(rangeId: string, now?: Date): {from?: string; to?: string};
