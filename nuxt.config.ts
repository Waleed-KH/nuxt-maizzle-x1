import { defineNuxtConfig } from 'nuxt/config';
import { probePlugin, reportPeakHeap, startHeapSampling } from './build/probe';
import { commonJSExclude, copyStylesheets, traceInclude } from './build/workarounds';

const probe = process.env.REPRO_PROBE === '1';

export default defineNuxtConfig({
	compatibilityDate: '2025-07-15',
	devtools: { enabled: false },

	nitro: {
		// Maizzle is a build tool the server runs: each render starts a Vite SSR
		// server. Keep it external, so Nitro copies it (and what it runs) into
		// `.output/server/node_modules` by tracing, instead of bundling it.
		externals: {
			external: ['@maizzle/framework'],
			traceInclude: traceInclude(),
		},

		commonJS: {
			exclude: commonJSExclude(),
		},

		hooks: {
			'rollup:before'(_nitro, config) {
				if (!probe) return;
				startHeapSampling();
				config.plugins = [config.plugins, probePlugin()];
			},
			async compiled(nitro) {
				await copyStylesheets(nitro.options.output.serverDir);
				if (probe) reportPeakHeap();
			},
		},
	},

	typescript: {
		// The build/ helpers run in Node, at build time.
		nodeTsConfig: {
			include: ['../build/**/*'],
		},
	},
});