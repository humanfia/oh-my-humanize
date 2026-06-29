import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";
import { freezeWorkflowArtifact } from "./freeze";
import { loadWorkflowArtifact } from "./package-loader";

export const OMHFLOW_DIR_ENV = "OMHFLOW_DIR";
export const EXPERIMENTAL_WORKFLOW_PREFIX = "experimental::";

type WorkflowFlowSource = "builtin" | "builtin-experimental" | "omhflow-dir";

export type WorkflowFlowSpec =
	| { kind: "path"; input: string; path: string }
	| {
			kind: "named";
			input: string;
			name: string;
			path: string;
			root: string;
			source: WorkflowFlowSource;
	  };

export interface WorkflowArtifactRegistryOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	flowDirs?: string[];
	builtinRoot?: string;
	builtinExperimentalRoot?: string;
}

export interface InstalledWorkflowArtifact {
	name: string;
	path: string;
	resourceDir: string;
	root: string;
}

export class WorkflowArtifactRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowArtifactRegistryError";
	}
}

export function getBuiltinWorkflowRoot(): string {
	return path.join(getPackageDir() ?? path.resolve(import.meta.dir, "../.."), "examples", "workflow");
}

export function getBuiltinExperimentalWorkflowRoot(builtinRoot = getBuiltinWorkflowRoot()): string {
	return path.join(builtinRoot, "experimental");
}

export function getDefaultInstalledWorkflowRoot(): string {
	return path.join(getConfigRootDir(), "flows");
}

export function workflowFlowDirs(options: WorkflowArtifactRegistryOptions = {}): string[] {
	if (options.flowDirs !== undefined) return options.flowDirs.map(dir => path.resolve(expandHome(dir)));
	const fromEnv = options.env?.[OMHFLOW_DIR_ENV] ?? process.env[OMHFLOW_DIR_ENV];
	if (!fromEnv?.trim()) return [getDefaultInstalledWorkflowRoot()];
	return fromEnv
		.split(path.delimiter)
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0)
		.map(entry => path.resolve(expandHome(entry)));
}

export async function resolveWorkflowFlowSpec(
	input: string,
	options: WorkflowArtifactRegistryOptions = {},
): Promise<WorkflowFlowSpec> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const builtinRoot = options.builtinRoot ?? getBuiltinWorkflowRoot();
	const experimentalRoot = options.builtinExperimentalRoot ?? getBuiltinExperimentalWorkflowRoot(builtinRoot);
	const nearMissExperimentalName = nearMissExperimentalWorkflowName(input);
	if (nearMissExperimentalName !== undefined) {
		const suggestion = `${EXPERIMENTAL_WORKFLOW_PREFIX}${nearMissExperimentalName}`;
		throw new WorkflowArtifactRegistryError(
			`workflow flow "${input}" was not found. Did you mean "${suggestion}"? Use ${EXPERIMENTAL_WORKFLOW_PREFIX}<name> for packaged experimental flows.`,
		);
	}

	const expandedInput = expandHome(input);
	const pathCandidate = path.isAbsolute(expandedInput) ? expandedInput : path.resolve(cwd, expandedInput);
	if (looksLikeWorkflowPath(input) || (await pathExists(pathCandidate))) {
		return { kind: "path", input, path: pathCandidate };
	}

	const experimentalName = experimentalWorkflowName(input);
	if (experimentalName !== undefined) {
		const experimentalCandidates = await namedFlowCandidates(
			experimentalRoot,
			experimentalName,
			"builtin-experimental",
			{
				displayNamePrefix: EXPERIMENTAL_WORKFLOW_PREFIX,
				input,
			},
		);
		if (experimentalCandidates[0] !== undefined) return experimentalCandidates[0];
		throw new WorkflowArtifactRegistryError(
			`workflow flow "${input}" was not found. Use a path, a verified built-in flow name, ${EXPERIMENTAL_WORKFLOW_PREFIX}<name>, or add a .omhflow artifact to ${OMHFLOW_DIR_ENV}.`,
		);
	}

	const namedCandidates = [
		...(await namedFlowCandidates(builtinRoot, input, "builtin")),
		...(await externalNamedFlowCandidates(input, workflowFlowDirs(options))),
	];
	if (namedCandidates.length > 1) {
		throw new WorkflowArtifactRegistryError(
			`workflow flow "${input}" is ambiguous across bundled and ${OMHFLOW_DIR_ENV} artifacts:\n${namedCandidates
				.map(match => `- ${match.source}: ${match.path}`)
				.join("\n")}\nUse an explicit .omhflow path to select one artifact.`,
		);
	}
	if (namedCandidates[0] !== undefined) return namedCandidates[0];

	const experimentalSuggestion = await experimentalNameSuggestion(experimentalRoot, input);
	const suggestion = experimentalSuggestion !== undefined ? ` Did you mean "${experimentalSuggestion}"?` : "";
	throw new WorkflowArtifactRegistryError(
		`workflow flow "${input}" was not found.${suggestion} Use a path, a verified built-in flow name, ${EXPERIMENTAL_WORKFLOW_PREFIX}<name>, or add a .omhflow artifact to ${OMHFLOW_DIR_ENV}.`,
	);
}

export async function listWorkflowFlowSpecs(
	options: WorkflowArtifactRegistryOptions = {},
): Promise<Extract<WorkflowFlowSpec, { kind: "named" }>[]> {
	const builtinRoot = options.builtinRoot ?? getBuiltinWorkflowRoot();
	const experimentalRoot = options.builtinExperimentalRoot ?? getBuiltinExperimentalWorkflowRoot(builtinRoot);
	const builtin = await listNamedFlowRoot(builtinRoot, "builtin");
	const experimental = await listNamedFlowRoot(experimentalRoot, "builtin-experimental", {
		displayNamePrefix: EXPERIMENTAL_WORKFLOW_PREFIX,
	});
	const externalRoots = workflowFlowDirs(options);
	const externalGroups = await Promise.all(externalRoots.map(root => listNamedFlowRoot(root, "omhflow-dir")));
	return [...builtin, ...experimental, ...externalGroups.flat()].sort((left, right) =>
		left.source === right.source ? left.name.localeCompare(right.name) : left.source.localeCompare(right.source),
	);
}

export async function installWorkflowArtifact(
	source: string,
	options: WorkflowArtifactRegistryOptions & { force?: boolean } = {},
): Promise<InstalledWorkflowArtifact> {
	const sourceFlowPath = await resolveInstallSourceFlowPath(source, options.cwd ?? process.cwd());
	const artifact = await loadWorkflowArtifact(sourceFlowPath);
	await freezeWorkflowArtifact(artifact);
	const name = safeFlowName(artifact.metadata.name);
	const root = workflowFlowDirs(options)[0] ?? getDefaultInstalledWorkflowRoot();
	const installDir = path.join(root, name);
	const targetFlowPath = path.join(installDir, `${name}.omhflow`);
	const targetResourceDir = path.join(installDir, name);
	if ((await pathExists(installDir)) && !options.force) {
		throw new WorkflowArtifactRegistryError(
			`workflow flow "${name}" is already installed at ${installDir}; pass --force to replace it`,
		);
	}
	if (await pathExists(installDir)) {
		await fs.rm(installDir, { recursive: true, force: true });
	}
	await fs.mkdir(installDir, { recursive: true });
	await Bun.write(targetFlowPath, await Bun.file(artifact.flowPath).text());
	await fs.cp(artifact.resourceDir, targetResourceDir, { recursive: true });
	await freezeWorkflowArtifact(await loadWorkflowArtifact(targetFlowPath));
	return { name, path: targetFlowPath, resourceDir: targetResourceDir, root };
}

export async function uninstallWorkflowArtifact(
	nameInput: string,
	options: WorkflowArtifactRegistryOptions = {},
): Promise<InstalledWorkflowArtifact> {
	const builtinRoot = options.builtinRoot ?? getBuiltinWorkflowRoot();
	const experimentalRoot = options.builtinExperimentalRoot ?? getBuiltinExperimentalWorkflowRoot(builtinRoot);
	const experimentalName = experimentalWorkflowName(nameInput);
	if (experimentalName !== undefined) {
		const builtinExperimental = await firstNamedFlowCandidate(
			experimentalRoot,
			experimentalName,
			"builtin-experimental",
			{
				displayNamePrefix: EXPERIMENTAL_WORKFLOW_PREFIX,
				input: nameInput,
			},
		);
		if (builtinExperimental !== undefined) {
			throw new WorkflowArtifactRegistryError(
				`built-in experimental workflow flow "${nameInput}" cannot be uninstalled`,
			);
		}
		throw new WorkflowArtifactRegistryError(`installed workflow flow "${nameInput}" was not found`);
	}
	const name = safeFlowName(nameInput);
	const external = await externalNamedFlowCandidates(name, workflowFlowDirs(options));
	if (external.length > 1) {
		throw new WorkflowArtifactRegistryError(
			`workflow flow "${name}" is ambiguous in ${OMHFLOW_DIR_ENV}:\n${external.map(match => `- ${match.path}`).join("\n")}`,
		);
	}
	const match = external[0];
	if (match === undefined) {
		const builtin = await firstNamedFlowCandidate(builtinRoot, name, "builtin");
		if (builtin !== undefined) {
			throw new WorkflowArtifactRegistryError(`built-in workflow flow "${name}" cannot be uninstalled`);
		}
		throw new WorkflowArtifactRegistryError(`installed workflow flow "${name}" was not found`);
	}
	const resourceDir = path.join(path.dirname(match.path), path.basename(match.path, ".omhflow"));
	await fs.rm(match.path, { force: true });
	await fs.rm(resourceDir, { recursive: true, force: true });
	await removeEmptyInstallContainer(match.root, match.path);
	return { name, path: match.path, resourceDir, root: match.root };
}

function looksLikeWorkflowPath(input: string): boolean {
	if (input.startsWith(".") || input.startsWith("~")) return true;
	if (input.includes("/") || input.includes("\\")) return true;
	if (path.isAbsolute(input)) return true;
	if (/^[A-Za-z]:[\\/]/.test(input)) return true;
	const ext = path.extname(input);
	return ext === ".omhflow" || ext === ".yml" || ext === ".yaml";
}

async function firstNamedFlowCandidate(
	root: string,
	name: string,
	source: WorkflowFlowSource,
	options: NamedFlowCandidateOptions = {},
): Promise<Extract<WorkflowFlowSpec, { kind: "named" }> | undefined> {
	const candidates = await namedFlowCandidates(root, name, source, options);
	return candidates[0];
}

async function externalNamedFlowCandidates(
	name: string,
	roots: readonly string[],
): Promise<Extract<WorkflowFlowSpec, { kind: "named" }>[]> {
	const groups = await Promise.all(roots.map(root => namedFlowCandidates(root, name, "omhflow-dir")));
	return groups.flat();
}

async function namedFlowCandidates(
	rootInput: string,
	name: string,
	source: WorkflowFlowSource,
	options: NamedFlowCandidateOptions = {},
): Promise<Extract<WorkflowFlowSpec, { kind: "named" }>[]> {
	const root = path.resolve(expandHome(rootInput));
	const safeName = safeFlowName(name);
	const displayName = `${options.displayNamePrefix ?? ""}${safeName}`;
	const input = options.input ?? displayName;
	const candidates = [path.join(root, `${safeName}.omhflow`), path.join(root, safeName, `${safeName}.omhflow`)];
	const matches: Extract<WorkflowFlowSpec, { kind: "named" }>[] = [];
	for (const candidate of candidates) {
		if (!(await pathExists(candidate))) continue;
		matches.push({ kind: "named", input, name: displayName, path: candidate, root, source });
	}
	return matches;
}

async function listNamedFlowRoot(
	rootInput: string,
	source: WorkflowFlowSource,
	options: NamedFlowCandidateOptions = {},
): Promise<Extract<WorkflowFlowSpec, { kind: "named" }>[]> {
	const root = path.resolve(expandHome(rootInput));
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const byPath = new Map<string, Extract<WorkflowFlowSpec, { kind: "named" }>>();
	for (const entry of entries) {
		const name = path.extname(entry) === ".omhflow" ? path.basename(entry, ".omhflow") : entry;
		let candidates: Extract<WorkflowFlowSpec, { kind: "named" }>[];
		try {
			candidates = await namedFlowCandidates(root, name, source, options);
		} catch {
			continue;
		}
		for (const candidate of candidates) byPath.set(candidate.path, candidate);
	}
	return [...byPath.values()];
}

async function resolveInstallSourceFlowPath(source: string, cwd: string): Promise<string> {
	const candidate = path.isAbsolute(expandHome(source)) ? expandHome(source) : path.resolve(cwd, expandHome(source));
	const stat = await statPath(candidate);
	if (!stat.isDirectory()) return candidate;
	const named = path.join(candidate, `${path.basename(candidate)}.omhflow`);
	if (await pathExists(named)) return named;
	const entries = await fs.readdir(candidate);
	const flowFiles = entries.filter(entry => path.extname(entry) === ".omhflow");
	if (flowFiles.length === 1) return path.join(candidate, flowFiles[0]!);
	throw new WorkflowArtifactRegistryError(
		`workflow install directory must contain exactly one .omhflow file or ${path.basename(candidate)}.omhflow`,
	);
}

async function statPath(candidate: string) {
	try {
		return await fs.stat(candidate);
	} catch (error) {
		throw new WorkflowArtifactRegistryError(`workflow artifact path is not readable: ${errorMessage(error)}`);
	}
}

async function pathExists(candidate: string): Promise<boolean> {
	try {
		await fs.stat(candidate);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function expandHome(input: string): string {
	if (input === "~") return process.env.HOME ?? input;
	if (input.startsWith("~/")) return path.join(process.env.HOME ?? "~", input.slice(2));
	return input;
}

function safeFlowName(input: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(input)) {
		throw new WorkflowArtifactRegistryError(`workflow flow name must be a safe path segment: ${input}`);
	}
	return input;
}

interface NamedFlowCandidateOptions {
	displayNamePrefix?: string;
	input?: string;
}

function experimentalWorkflowName(input: string): string | undefined {
	if (!input.startsWith(EXPERIMENTAL_WORKFLOW_PREFIX)) return undefined;
	const name = input.slice(EXPERIMENTAL_WORKFLOW_PREFIX.length);
	return name.length > 0 ? name : undefined;
}

function nearMissExperimentalWorkflowName(input: string): string | undefined {
	for (const prefix of ["experimental:", "experimental/"]) {
		if (!input.startsWith(prefix)) continue;
		const name = input.slice(prefix.length);
		return name.length > 0 && safeFlowNameOrNull(name) !== null ? name : undefined;
	}
	return undefined;
}

function safeFlowNameOrNull(input: string): string | null {
	try {
		return safeFlowName(input);
	} catch {
		return null;
	}
}

async function experimentalNameSuggestion(root: string, input: string): Promise<string | undefined> {
	if (input.includes(":") || input.includes("/") || input.includes("\\")) return undefined;
	try {
		const candidate = await firstNamedFlowCandidate(root, input, "builtin-experimental", {
			displayNamePrefix: EXPERIMENTAL_WORKFLOW_PREFIX,
		});
		return candidate?.name;
	} catch {
		return undefined;
	}
}

async function removeEmptyInstallContainer(root: string, flowPath: string): Promise<void> {
	const container = path.dirname(flowPath);
	if (path.resolve(container) === path.resolve(root)) return;
	try {
		const entries = await fs.readdir(container);
		if (entries.length === 0) await fs.rmdir(container);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
