/*
 * Everything the Nitro build needs to be told before `.output` can render an
 * email. Each workaround can be switched off for a build to reproduce what it
 * covers: REPRO_DISABLE=<name>[,<name>...] or REPRO_DISABLE=all (scripts/build.mjs
 * sets it from --disable). See README.md for what each one is for.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMusl } from './rolldown-binding';

export const WORKAROUNDS = [
	'trace-rolldown-binding',
	'trace-lightningcss-binding',
	'trace-vue-router',
	'trace-compiler-sfc',
	'copy-css',
	'cjs-exclude',
] as const;

export type Workaround = (typeof WORKAROUNDS)[number];

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const disabled = new Set((process.env.REPRO_DISABLE ?? '').split(',').map(s => s.trim()).filter(Boolean));
for (const name of disabled) {
	if (name !== 'all' && !(WORKAROUNDS as readonly string[]).includes(name)) {
		throw new Error(`Unknown workaround "${name}". Known: all, ${WORKAROUNDS.join(', ')}.`);
	}
}

export function enabled(workaround: Workaround): boolean {
	return !disabled.has('all') && !disabled.has(workaround);
}

/**
 * The real directory of package `name` as seen from `fromDir`, found the way
 * Node walks `node_modules`. By directory rather than `require.resolve`, which
 * fails for packages whose exports map has no `require` condition
 * (@maizzle/framework) or does not export `./package.json` (lightningcss).
 */
function packageDir(name: string, fromDir: string): string {
	const paths = createRequire(join(fromDir, 'noop.js')).resolve.paths(name) ?? [];
	for (const dir of paths) {
		if (existsSync(join(dir, name, 'package.json'))) return realpathSync(join(dir, name));
	}
	throw new Error(`Cannot find ${name} from ${fromDir}.`);
}

/**
 * Resolves `target` from the end of a chain of packages, each found from the
 * one before it. pnpm exposes only the app's own dependencies at its root, so a
 * transitive package is reached by walking down to it, and this also picks the
 * exact copy the runtime loads when several versions are installed.
 */
function resolveIn(chain: string[], target: string): string {
	let dir = ROOT;
	for (const name of chain) dir = packageDir(name, dir);
	return createRequire(join(dir, 'package.json')).resolve(target);
}

/**
 * Set by the Docker build, which runs on Debian (glibc) but ships an Alpine
 * (musl) runtime: the bindings to trace are the runtime's. The build stage
 * installs the musl packages too (`pnpm install --libc=glibc --libc=musl`).
 */
const forceMusl = process.env.FORCE_MUSL === 'true';

/** How napi-rs packages name their per-platform binding: `win32-x64-msvc`, `linux-x64-gnu`, `linux-x64-musl`, ... */
function platformSuffix(): string {
	const { platform, arch } = process;
	if (platform === 'linux') return `linux-${arch}-${forceMusl || isMusl() ? 'musl' : 'gnu'}`;
	if (platform === 'darwin') return `darwin-${arch}`;
	if (platform === 'win32') return `win32-${arch}-msvc`;
	throw new Error(`Extend platformSuffix() for ${platform}.`);
}

/**
 * `nitro.externals.traceInclude`: what the server loads at runtime through calls
 * no static analysis can follow. Absolute paths, each resolved here so a typo
 * fails the build: Nitro skips an entry it cannot resolve without a word.
 */
export function traceInclude(): string[] {
	const binding = platformSuffix();
	const entries: [Workaround, () => string][] = [
		// Loaded by name built from platform/arch/libc at runtime.
		['trace-rolldown-binding', () => resolveIn(['@maizzle/framework', 'vite', 'rolldown'], `@rolldown/binding-${binding}`)],
		['trace-lightningcss-binding', () => resolveIn(['@maizzle/framework', 'lightningcss'], `lightningcss-${binding}`)],
		// Maizzle locates it with import.meta.resolve to alias it for Vite.
		['trace-vue-router', () => resolveIn(['@maizzle/framework'], 'vue-router')],
		// @vitejs/plugin-vue requires it through a createRequire built at runtime.
		['trace-compiler-sfc', () => resolveIn([], 'vue/compiler-sfc')],
	];

	return entries.filter(([name]) => enabled(name)).map(([, resolve]) => resolve());
}

/**
 * `nitro.commonJS.exclude`: entries the CommonJS plugin must not load. To decide
 * an import is external, Nitro resolves it through Rollup, and the CommonJS
 * plugin loads the target (then its imports, and so on) to inspect it. Nothing
 * loaded that way is bundled, but all of it is parsed and kept in memory.
 * See README.md, "1. The build loads every external's whole dependency graph".
 */
export function commonJSExclude(): RegExp[] {
	if (!enabled('cjs-exclude')) return [];
	return [/[\\/]node_modules[\\/](@maizzle[\\/]framework|vue[\\/]compiler-sfc)[\\/]/];
}


/**
 * Copies the stylesheets Tailwind loads mid-render into the build output. They
 * cannot go through `traceInclude`: a `.css` entry resolves to a virtual
 * `\0raw:` id that the tracer then tries to open as a path. And nothing imports
 * them: Tailwind's resolver reads them while compiling the email's `<style>`.
 */
export async function copyStylesheets(serverDir: string): Promise<void> {
	if (!enabled('copy-css')) return;

	const modules = join(serverDir, 'node_modules');

	// Ships nothing but CSS, so the trace misses all of it.
	await cp(packageDir('@maizzle/tailwindcss', ROOT), join(modules, '@maizzle', 'tailwindcss'), { recursive: true, dereference: true });

	// Traced for its JavaScript, which leaves out the stylesheets its exports map
	// points at (`tailwindcss/theme` and friends).
	const tailwind = packageDir('tailwindcss', packageDir('@tailwindcss/postcss', packageDir('@maizzle/framework', ROOT)));
	const version = (JSON.parse(readFileSync(join(tailwind, 'package.json'), 'utf8')) as { version: string }).version;
	for (const file of ['index.css', 'theme.css', 'preflight.css', 'utilities.css']) {
		await cp(join(tailwind, file), join(modules, 'tailwindcss', file));
	}
	console.log(`[repro] copied @maizzle/tailwindcss and tailwindcss@${version} stylesheets into ${modules}`);
}