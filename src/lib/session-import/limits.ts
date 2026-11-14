/** Shared by the browser and the API; this module must remain free of server-only imports. */
export const INITIAL_SCAN_LIMIT = 50;
export const MAX_SCAN_LIMIT = 1000;
export const MAX_IMPORT_SELECTION = 500;
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
