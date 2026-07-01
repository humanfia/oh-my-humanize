#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const DEFAULT_BIN_NAMES = ["omh", "omp"] as const;

export interface LinkDevLaunchersOptions {
	repoRoot?: string;
	binDir?: string;
	binNames?: readonly string[];
}

export function resolveBunGlobalBin(env: Record<string, string | undefined> = process.env): string {
	const explicit = env.OMH_DEV_BIN_DIR?.trim();
	if (explicit) return explicit;

	const bunInstall = env.BUN_INSTALL?.trim();
	if (bunInstall) return path.join(bunInstall, "bin");

	const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
	return path.join(home, ".bun", "bin");
}

export async function linkDevLaunchers(options: LinkDevLaunchersOptions = {}): Promise<string[]> {
	if (process.platform === "win32") {
		throw new Error("bun setup dev launcher symlinks are POSIX-only; use scripts/install.ps1 on Windows.");
	}

	const repoRoot = options.repoRoot ?? path.resolve(import.meta.dir, "..");
	const binDir = options.binDir ?? resolveBunGlobalBin();
	const launcher = path.join(repoRoot, "packages", "coding-agent", "scripts", "omp");
	const binNames = options.binNames ?? DEFAULT_BIN_NAMES;

	await fs.access(launcher);
	await fs.mkdir(binDir, { recursive: true });

	const linked: string[] = [];
	for (const name of binNames) {
		const destination = path.join(binDir, name);
		await fs.rm(destination, { force: true });
		await fs.symlink(launcher, destination);
		linked.push(destination);
	}

	return linked;
}

export async function runSetup(): Promise<void> {
	await $`bun install`;
	await $`bun run build:native`;

	const linked = await linkDevLaunchers();
	for (const destination of linked) {
		console.log(`Linked ${destination}`);
	}
}

if (import.meta.main) {
	await runSetup();
}
