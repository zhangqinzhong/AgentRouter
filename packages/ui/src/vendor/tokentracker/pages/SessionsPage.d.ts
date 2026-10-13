import type {ComponentType} from 'react';
export const SessionsPage: ComponentType<{defaultRange?: "all" | "7d" | "30d" | "90d"}>;

export function sessionQueryRange(rangeId: string, now?: Date): {from?: string; to?: string};

export function matchingSessionProfiles(profiles: any[], session: any): any[];
export function profileOpenSurfaces(profile: any): Array<'cli'|'app'>;
export function resumeExtraArgs(source: string, id: string): string[];
export const ResumeHoverButton: import('react').ComponentType<any>;

export function rangeStartMs(rangeId:string,now?:Date):number;
export function overlapsRange(session:any,startMs:number):boolean;
