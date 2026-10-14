import { join } from 'node:path';

/**
 * The directory holding the `node_modules` the server resolves packages from:
 * the app directory under `nuxt dev`, `.output/server` in a build. A build is
 * expected to be started from the directory holding `.output`.
 *
 * Not derived from `import.meta.url`: in a build that is a placeholder while the
 * server chunks load (see server/plugins/import-meta.ts).
 */
export const SERVER_DIR = import.meta.dev ? process.cwd() : join(process.cwd(), '.output', 'server');