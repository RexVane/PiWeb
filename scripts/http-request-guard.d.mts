import type { IncomingMessage, ServerResponse } from "node:http";
export const MAX_BODY_BYTES: number;
export const PUBLIC_BODY_BYTES: number;
export const MAX_INFLIGHT_BYTES: number;
export const MAX_UPLOAD_BODY_BYTES: number;
export function createRequestGuard(options?: {env?: Record<string, string | undefined>; maxBodyBytes?: number; maxUploadBodyBytes?: number; maxInflightBytes?: number; bodyTimeoutMs?: number}): (req: IncomingMessage, res: ServerResponse) => boolean;
export function installRequestGuard(options?: {env?: Record<string, string | undefined>; maxBodyBytes?: number; maxUploadBodyBytes?: number; maxInflightBytes?: number; bodyTimeoutMs?: number}): void;
export function requestGuardInstalled(port?: number | string): boolean;
