import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import {
	type WorkflowCheckpointSnapshot,
	type WorkflowCheckpointWorkspaceSnapshot,
	WorkflowLifecycleError,
} from "./lifecycle";

export interface WorkflowCheckpointWorkspaceCaptureOptions {
	ignoredDirtyPathPrefixes?: readonly string[];
}

export interface WorkflowCheckpointWorkspaceMatchOptions {
	ignoredDirtyPathPrefixes?: readonly string[];
}

export async function captureWorkflowCheckpointWorkspace(
	workspaceRoot: string | undefined,
	options: WorkflowCheckpointWorkspaceCaptureOptions = {},
): Promise<WorkflowCheckpointWorkspaceSnapshot | undefined> {
	if (workspaceRoot === undefined) return undefined;
	try {
		const repoRoot = await git.repo.root(workspaceRoot);
		if (repoRoot === null) return unavailableWorkspaceSnapshot("git repository not found");
		const ignoredDirtyPathPrefixes = normalizeIgnoredDirtyPathPrefixes(
			repoRoot,
			options.ignoredDirtyPathPrefixes ?? [],
		);
		const [statusText, stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
			git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all" }),
			git.diff(repoRoot, { cached: true, binary: true, allowFailure: true }),
			git.diff(repoRoot, { binary: true, allowFailure: true }),
			git.ls.untracked(repoRoot),
		]);
		const normalizedStatusText = filterWorkspaceStatusText(statusText, ignoredDirtyPathPrefixes);
		const dirtyPaths = parseWorkspaceDirtyPaths(normalizedStatusText);
		const untrackedDigests = await untrackedWorkspaceFileDigests(
			repoRoot,
			untrackedFiles.filter(file => !isIgnoredWorkspacePath(file, ignoredDirtyPathPrefixes)),
		);
		const digest = workspaceDigest([
			"kind=git",
			`status=${dirtyPaths.length === 0 ? "clean" : "dirty"}`,
			`statusText\n${normalizedStatusText}`,
			`stagedDiff\n${stagedDiff}`,
			`unstagedDiff\n${unstagedDiff}`,
			`untracked\n${untrackedDigests.join("\n")}`,
		]);
		const snapshot: WorkflowCheckpointWorkspaceSnapshot = {
			kind: "git",
			status: dirtyPaths.length === 0 ? "clean" : "dirty",
			digest,
			dirtyPaths,
		};
		if (normalizedStatusText.trim().length > 0) snapshot.statusText = normalizedStatusText;
		return snapshot;
	} catch (error) {
		return unavailableWorkspaceSnapshot(error instanceof Error ? error.message : String(error));
	}
}

export async function assertWorkflowCheckpointWorkspaceMatches(
	checkpoint: WorkflowCheckpointSnapshot,
	workspaceRoot: string | undefined,
	options: WorkflowCheckpointWorkspaceMatchOptions = {},
): Promise<void> {
	if (checkpoint.workspace === undefined) return;
	const actual = await captureWorkflowCheckpointWorkspace(workspaceRoot, {
		ignoredDirtyPathPrefixes: [
			...workflowRuntimeScratchDirtyPathPrefixes(workspaceRoot),
			...(options.ignoredDirtyPathPrefixes ?? []),
		],
	});
	if (actual === undefined) {
		throw new WorkflowLifecycleError(
			`Workflow checkpoint ${checkpoint.id} saved workspace state, but restart has no workspace root to validate`,
		);
	}
	if (
		actual.kind === checkpoint.workspace.kind &&
		actual.status === checkpoint.workspace.status &&
		actual.digest === checkpoint.workspace.digest
	) {
		return;
	}
	throw new WorkflowLifecycleError(
		[
			`Workflow checkpoint workspace state does not match current workspace: ${checkpoint.id}`,
			`checkpoint=${formatWorkspaceSnapshot(checkpoint.workspace)}`,
			`current=${formatWorkspaceSnapshot(actual)}`,
		].join("; "),
	);
}

export function assertWorkflowWorkspaceSnapshotUnchanged(
	before: WorkflowCheckpointWorkspaceSnapshot | undefined,
	after: WorkflowCheckpointWorkspaceSnapshot | undefined,
	nodeId: string,
): void {
	if (before === undefined || after === undefined) return;
	if (before.kind === after.kind && before.status === after.status && before.digest === after.digest) return;
	throw new WorkflowLifecycleError(
		[
			`workflow node "${nodeId}" declared workspaceAccess=read but changed workspace`,
			`before=${formatWorkspaceSnapshot(before)}`,
			`after=${formatWorkspaceSnapshot(after)}`,
		].join("; "),
	);
}

export function workflowRuntimeScratchDirtyPathPrefixes(workspaceRoot: string | undefined): string[] {
	if (workspaceRoot === undefined) return [];
	return normalizeIgnoredDirtyPathPrefixes(workspaceRoot, [
		"workflow-output/omh-runtime",
		"monitor-assignment.json",
		process.env.OMH_RUN_TMP,
		Bun.env.OMH_RUN_TMP,
		process.env.TMPDIR,
		Bun.env.TMPDIR,
	]);
}

function unavailableWorkspaceSnapshot(error: string): WorkflowCheckpointWorkspaceSnapshot {
	return {
		kind: "unknown",
		status: "unavailable",
		digest: workspaceDigest(["kind=unknown", `error=${error}`]),
		dirtyPaths: [],
		error,
	};
}

function filterWorkspaceStatusText(statusText: string, ignoredDirtyPathPrefixes: readonly string[]): string {
	if (ignoredDirtyPathPrefixes.length === 0) return statusText;
	const lines: string[] = [];
	for (const rawLine of statusText.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.length === 0) continue;
		const pathText = line.slice(3);
		const paths = pathText.includes(" -> ") ? pathText.split(" -> ") : [pathText];
		if (paths.every(entry => isIgnoredWorkspacePath(entry, ignoredDirtyPathPrefixes))) continue;
		lines.push(rawLine);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function parseWorkspaceDirtyPaths(statusText: string): string[] {
	const paths = new Set<string>();
	for (const rawLine of statusText.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.length === 0) continue;
		const pathText = line.slice(3);
		if (pathText.includes(" -> ")) {
			for (const entry of pathText.split(" -> ")) addWorkspacePath(paths, entry);
			continue;
		}
		addWorkspacePath(paths, pathText);
	}
	return [...paths].sort();
}

function addWorkspacePath(paths: Set<string>, value: string): void {
	const normalized = value.trim();
	if (normalized.length === 0) return;
	paths.add(normalized);
}

function normalizeIgnoredDirtyPathPrefixes(repoRoot: string, prefixes: readonly (string | undefined)[]): string[] {
	const normalized = new Set<string>();
	for (const prefix of prefixes) {
		if (prefix === undefined) continue;
		const trimmed = prefix.trim();
		if (trimmed.length === 0) continue;
		const absolutePath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(repoRoot, trimmed);
		const relative = path.relative(repoRoot, absolutePath);
		if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		normalized.add(toWorkspacePath(relative));
	}
	return [...normalized].sort();
}

function isIgnoredWorkspacePath(value: string, ignoredDirtyPathPrefixes: readonly string[]): boolean {
	if (ignoredDirtyPathPrefixes.length === 0) return false;
	const normalized = toWorkspacePath(value.trim());
	return ignoredDirtyPathPrefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function toWorkspacePath(value: string): string {
	return value.split(path.sep).join("/");
}

async function untrackedWorkspaceFileDigests(repoRoot: string, files: string[]): Promise<string[]> {
	const sorted = [...files].sort();
	const digests: string[] = [];
	for (const file of sorted) {
		digests.push(await untrackedWorkspaceFileDigest(repoRoot, file));
	}
	return digests;
}

async function untrackedWorkspaceFileDigest(repoRoot: string, file: string): Promise<string> {
	const filePath = path.resolve(repoRoot, file);
	const relative = path.relative(repoRoot, filePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return `${file}\tescaped`;
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return `${file}\tnon-file\t${stat.mode}\t${stat.size}`;
		const content = await fs.readFile(filePath);
		const contentDigest = workspaceDigest([content]);
		return `${file}\tfile\t${stat.mode}\t${stat.size}\t${contentDigest}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `${file}\tunreadable\t${message}`;
	}
}

function workspaceDigest(parts: Array<string | Uint8Array>): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hasher.update(part);
		hasher.update("\0");
	}
	return `sha256:${hasher.digest("hex")}`;
}

function formatWorkspaceSnapshot(snapshot: WorkflowCheckpointWorkspaceSnapshot): string {
	const paths = snapshot.dirtyPaths.length === 0 ? "none" : snapshot.dirtyPaths.join(",");
	return `${snapshot.kind}/${snapshot.status}/${snapshot.digest}/dirty=${paths}`;
}
