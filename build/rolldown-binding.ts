/**
 * Whether this machine's libc is musl, decided the way rolldown decides it when
 * it picks its native binding, so the build ships the binding rolldown loads.
 *
 * Adapted from rolldown (MIT, Copyright (c) 2024-present VoidZero Inc. & Contributors):
 * https://github.com/rolldown/rolldown/blob/main/packages/rolldown/src/binding.cjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const isMusl = () => {
	let musl: boolean | null = false;
	if (process.platform === 'linux') {
		musl = isMuslFromFilesystem();
		if (musl === null) {
			musl = isMuslFromReport();
		}
		if (musl === null) {
			musl = isMuslFromChildProcess();
		}
	}
	return musl;
};

const isFileMusl = (f: string) => f.includes('libc.musl-') || f.includes('ld-musl-');

const isMuslFromFilesystem = () => {
	try {
		return readFileSync('/usr/bin/ldd', 'utf-8').includes('musl');
	} catch {
		return null;
	}
};

/** The fields of a diagnostic report the check reads; `getReport()` is typed as a bare `object`. */
interface LibcReport {
	header?: { glibcVersionRuntime?: string };
	sharedObjects?: string[];
}

/** `excludeNetwork` exists at runtime (Node 22.13+) but is missing from `@types/node`. */
type ProcessReportWithNetwork = NodeJS.ProcessReport & { excludeNetwork?: boolean };

const isMuslFromReport = () => {
	let report: LibcReport | null = null;
	const processReport = process.report as ProcessReportWithNetwork | undefined;
	if (processReport && typeof processReport.getReport === 'function') {
		processReport.excludeNetwork = true;
		report = processReport.getReport() as LibcReport;
	}
	if (!report) {
		return null;
	}
	if (report.header && report.header.glibcVersionRuntime) {
		return false;
	}
	if (Array.isArray(report.sharedObjects)) {
		if (report.sharedObjects.some(isFileMusl)) {
			return true;
		}
	}
	return false;
};

const isMuslFromChildProcess = () => {
	try {
		return execSync('ldd --version', { encoding: 'utf8' }).includes('musl');
	} catch {
		// If we reach this case, we don't know if the system is musl or not, so is better to just fallback to false
		return false;
	}
};