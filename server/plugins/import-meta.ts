/*
 * Shows what `import.meta.url` is while the server's chunks are loading.
 *
 * A Nitro build replaces `import.meta.url` with `globalThis._importMeta_.url`.
 * Every chunk initialises that to `{ url: "file:///_entry.js" }` if unset, and
 * the real value is assigned in the body of `.output/server/index.mjs`, which
 * ESM runs only after the chunks it imports have been evaluated. Plugins are
 * bundled into one of those chunks, so this module-level read sees the
 * placeholder. /api/render reports it next to the value read during a request.
 */
const atLoad = import.meta.url;

export default defineNitroPlugin(() => {
	(globalThis as { __importMetaUrlAtLoad?: string }).__importMetaUrlAtLoad = atLoad;
});