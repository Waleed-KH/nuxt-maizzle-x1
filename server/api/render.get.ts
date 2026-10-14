import { render } from '@maizzle/framework';
import { SERVER_DIR } from '../utils/paths';

/**
 * An email that needs the whole runtime chain: Vue SSR through Maizzle's Vite
 * server (rolldown's native binding), Tailwind through PostCSS (lightningcss's
 * native binding, @maizzle/tailwindcss's CSS) and Maizzle's built-in components.
 * `source(none)`: Tailwind scans no files; Maizzle hands it the email's classes.
 */
const TEMPLATE = `<template>
  <Html>
    <Head>
      <style>
        @import "@maizzle/tailwindcss" source(none);
      </style>
    </Head>
    <Body>
      <p class="text-red-500">Hello from Maizzle</p>
    </Body>
  </Html>
</template>`;

export default defineEventHandler(async (event) => {
	const started = performance.now();
	const importMetaUrl = {
		atLoad: (globalThis as { __importMetaUrlAtLoad?: string }).__importMetaUrlAtLoad,
		atRequest: import.meta.url,
	};

	try {
		const { html } = await render(TEMPLATE, {
			// Maizzle roots its Vite server here (`vue/server-renderer` and the like
			// resolve from it) and, since @maizzle/framework 6.2, resolves the
			// Tailwind `@import` from it. Its default is the working directory.
			root: SERVER_DIR,
		});

		// When Tailwind cannot resolve its import, Maizzle skips the pass and logs:
		// the email comes back well formed, unstyled, with the import left in it.
		const tailwindCompiled = !/@import\s+["']@maizzle\/tailwindcss/.test(html);
		const paragraph = /<p[^>]*>Hello from Maizzle<\/p>/.exec(html)?.[0];

		return {
			ok: tailwindCompiled && /color:/.test(paragraph ?? ''),
			tailwindCompiled,
			paragraph,
			ms: Math.round(performance.now() - started),
			importMetaUrl,
		};
	} catch (error) {
		setResponseStatus(event, 500);

		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			ms: Math.round(performance.now() - started),
			importMetaUrl,
		};
	}
});