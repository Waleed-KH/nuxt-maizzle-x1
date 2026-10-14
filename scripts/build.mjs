/**
 * Builds the app, optionally with workarounds switched off.
 *
 *   node scripts/build.mjs                         all workarounds on
 *   node scripts/build.mjs --disable=cjs-exclude   one (or a comma list, or "all") off
 *   node scripts/build.mjs --heap=2048             cap the V8 heap (MB), as on a CI runner
 *   node scripts/build.mjs --probe                 report modules parsed and peak heap
 *
 * Workaround names are listed in build/workarounds.ts and README.md.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		disable: { type: 'string', default: '' },
		heap: { type: 'string' },
		probe: { type: 'boolean', default: false },
	},
});

const env = { ...process.env, REPRO_DISABLE: values.disable };
if (values.probe) env.REPRO_PROBE = '1';
if (values.heap) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --max-old-space-size=${values.heap}`.trim();

console.log(`[repro] building with workarounds disabled: ${values.disable || '(none)'}${values.heap ? `, heap capped at ${values.heap} MB` : ''}`);

const nuxt = join(import.meta.dirname, '..', 'node_modules', 'nuxt', 'bin', 'nuxt.mjs');
const started = Date.now();
const result = spawnSync(process.execPath, [nuxt, 'build'], { stdio: 'inherit', env });
const seconds = Math.round((Date.now() - started) / 1000);

if (result.status === 0) {
	console.log(`[repro] build finished in ${seconds}s`);
} else {
	const oom = result.status === 134 || result.signal === 'SIGABRT';
	console.log(`[repro] build failed after ${seconds}s (exit ${result.status ?? result.signal})${oom ? ': V8 ran out of heap' : ''}`);
}
process.exit(result.status ?? 1);