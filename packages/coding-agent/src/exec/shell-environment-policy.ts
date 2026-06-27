import { buildNonInteractiveEnv } from "./non-interactive-env";

export type ShellEnvironmentPolicy = "isolated" | "workflow";

export function buildShellEnvironment(
	policy: ShellEnvironmentPolicy | undefined,
	overrides?: Record<string, string>,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	if (policy === "workflow") {
		return buildWorkflowShellEnvironment(overrides, baseEnv, platform);
	}
	return buildNonInteractiveEnv(overrides, baseEnv, platform);
}

export function buildWorkflowShellEnvironment(
	overrides?: Record<string, string>,
	baseEnv: Record<string, string | undefined> = Bun.env,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const inheritedEnv = definedShellEnvironment(baseEnv);
	delete inheritedEnv.PYTHONNOUSERSITE;
	delete inheritedEnv.PYTHONPATH;
	const env = {
		...inheritedEnv,
		...buildNonInteractiveEnv(overrides, baseEnv, platform),
	};
	if (!hasEnvOverride(overrides, "PYTHONNOUSERSITE", platform)) delete env.PYTHONNOUSERSITE;
	return env;
}

function definedShellEnvironment(baseEnv: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function hasEnvOverride(
	overrides: Record<string, string> | undefined,
	key: string,
	platform: NodeJS.Platform,
): boolean {
	if (!overrides) return false;
	if (platform !== "win32") return overrides[key] !== undefined;
	const normalizedKey = key.toLowerCase();
	return Object.keys(overrides).some(candidate => candidate.toLowerCase() === normalizedKey);
}
