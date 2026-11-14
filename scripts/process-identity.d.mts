export interface ProcessIdentity { alive: boolean | undefined; birth: string | null }
export function processIdentity(pid: number): ProcessIdentity;
export function processIdentityAlive(pid: number, birth?: string | null): boolean | undefined;
