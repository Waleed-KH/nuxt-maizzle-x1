/**
 * Runs `.output` the way it is deployed, and renders an email through it.
 *
 * Copies `.output` into a fresh temporary directory, so no `node_modules` above
 * it can supply what the build failed to copy, and starts it without NODE_PATH:
 * pnpm points NODE_PATH at its whole store when it runs a script, and Tailwind's
 * resolver honours it, which would hide a missing package the same way.
 */
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = join(import.meta.dirname, '..', '.output');
const dir = await mkdtemp(join(tmpdir(), 'nuxt-maizzle-x1-'));
await cp(output, join(dir, '.output'), { recursive: true });

const port = await new Promise((resolve) => {
	const probe = createServer().listen(0, '127.0.0.1', () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});

const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
delete env.NODE_PATH;

const server = spawn(process.execPath, [join('.output', 'server', 'index.mjs')], { cwd: dir, env });
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });

let result;
const deadline = Date.now() + 90_000;
while (!result && Date.now() < deadline && server.exitCode === null) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/render`);
		result = { status: response.status, body: await response.json() };
	} catch {
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

server.kill();
await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
await rm(dir, { recursive: true, force: true }).catch(() => {});

console.log(`[check] .output copied to ${dir}, started with cwd there and no NODE_PATH`);
if (!result) {
	console.log('[check] the server never answered. Its output:');
	console.log(log.trim());
	process.exit(1);
}

console.log(`[check] GET /api/render -> ${result.status}`);
console.log(JSON.stringify(result.body, null, 2));
const errors = log.split('\n').filter(line => /error|cannot|can't|failed/i.test(line)).slice(0, 10);
if (errors.length) {
	console.log('[check] server log, error lines:');
	console.log(errors.map(line => `  ${line.trim()}`).join('\n'));
}
console.log(result.body.ok ? '[check] OK: the email rendered with Tailwind' : '[check] FAILED');
process.exit(result.body.ok ? 0 : 1);