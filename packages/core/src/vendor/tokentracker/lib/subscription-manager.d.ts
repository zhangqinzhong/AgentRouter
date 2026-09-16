export function listSubscriptions(options:{trackerDir:string}): Promise<Array<Record<string,unknown>>>;
export function createSubscription(options:{trackerDir:string;fields:Record<string,unknown>}): Promise<unknown>;
export function updateSubscription(options:{trackerDir:string;id:string;fields:Record<string,unknown>}): Promise<unknown>;
export function deleteSubscription(options:{trackerDir:string;id:string}): Promise<unknown>;
