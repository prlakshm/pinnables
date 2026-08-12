/**
 * Browser-safe surface. Storage touches node:fs and node:path, so it is a
 * separate entry point (`@pinnables/shared/storage`) — importing it from here
 * would drag Node builtins into the extension bundle.
 */
export * from "./schema.js";
export * from "./page.js";
export * from "./styles.js";
export * from "./perception.js";
export * from "./drawings.js";
export * from "./render.js";
