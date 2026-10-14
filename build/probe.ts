/*
 * REPRO_PROBE=1 (scripts/build.mjs --probe): reports what the Nitro server
 * build parsed, and the heap it took. Measurement only; changes nothing.
 */
import type { Plugin } from 'rollup';

const MB = 1024 * 1024;
let peakHeap = 0;
let sampler: ReturnType<typeof setInterval> | undefined;

function sample() {
	peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}

/** Starts sampling the heap; call when the Nitro build starts. */
export function startHeapSampling(): void {
	sampler ??= setInterval(sample, 50);
	sampler.unref();
}

/** Stops sampling and prints the peak; call when the Nitro build is done. */
export function reportPeakHeap(): void {
	sample();
	if (sampler) clearInterval(sampler);
	console.log(`[probe] peak heap during the Nitro build: ${Math.round(peakHeap / MB)} MB`);
}

function packageName(id: string): string | undefined {
	return /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id)?.[1]?.replace(/\\/g, '/');
}

/**
 * A Rollup plugin that, once the Nitro server bundle is built (after Nitro's own
 * `buildEnd`, which resolves the `traceInclude` entries), counts the modules
 * Rollup parsed and how many of them cannot be reached from the bundle's
 * entries: loaded only to be inspected, never part of the output.
 */
export function probePlugin(): Plugin {
	return {
		name: 'repro:probe',
		renderStart() {
			const ids = [...this.getModuleIds()];
			const reachable = new Set<string>();
			const queue = ids.filter(id => this.getModuleInfo(id)?.isEntry);
			while (queue.length) {
				const id = queue.pop()!;
				if (reachable.has(id)) continue;
				reachable.add(id);
				const info = this.getModuleInfo(id);
				if (info) queue.push(...info.importedIds, ...info.dynamicallyImportedIds);
			}

			let parsed = 0;
			let parsedBytes = 0;
			let unreachable = 0;
			let unreachableBytes = 0;
			const byPackage = new Map<string, number>();

			for (const id of ids) {
				const info = this.getModuleInfo(id);
				if (!info || info.isExternal || info.code == null) continue;
				parsed++;
				parsedBytes += info.code.length;
				if (reachable.has(id)) continue;
				unreachable++;
				unreachableBytes += info.code.length;
				const pkg = packageName(id) ?? '(app)';
				byPackage.set(pkg, (byPackage.get(pkg) ?? 0) + info.code.length);
			}

			sample();
			console.log(`[probe] Rollup parsed ${parsed} modules (${(parsedBytes / MB).toFixed(1)} MB of source); live heap ${Math.round(process.memoryUsage().heapUsed / MB)} MB`);
			console.log(`[probe] ${unreachable} of them (${(unreachableBytes / MB).toFixed(1)} MB) are unreachable from the bundle's entries: loaded to be inspected, never bundled`);
			if (byPackage.size) {
				const top = [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, bytes]) => `${name} ${(bytes / 1024).toFixed(0)} KB`);
				console.log(`[probe] largest of those: ${top.join(', ')}`);
			}
		},
	};
}