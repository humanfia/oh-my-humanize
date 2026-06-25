import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as git from "../utils/git";
import {
	type WorkflowCheckpointSnapshot,
	type WorkflowCheckpointWorkspaceSnapshot,
	WorkflowLifecycleError,
} from "./lifecycle";

export async function captureWorkflowCheckpointWorkspace(
	workspaceRoot: string | undefined,
): Promise<WorkflowCheckpointWorkspaceSnapshot | undefined> {
	if (workspaceRoot === undefined) return undefined;
	try {
		const repoRoot = await git.repo.root(workspaceRoot);
		if (repoRoot === null) return unavailableWorkspaceSnapshot("git repository not found");
		const [statusText, stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
			git.status(repoRoot, { porcelainV1: true, untrackedFiles: "all" }),
			git.diff(repoRoot, { cached: true, binary: true, allowFailure: true }),
			git.diff(repoRoot, { binary: true, allowFailure: true }),
			git.ls.untracked(repoRoot),
		]);
		const dirtyPaths = parseWorkspaceDirtyPaths(statusText);
		const untrackedDigests = await untrackedWorkspaceFileDigests(repoRoot, untrackedFiles);
		const digest = workspaceDigest([
			"kind=git",
			`status=${dirtyPaths.length === 0 ? "clean" : "dirty"}`,
			`statusText\n${statusText}`,
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
		if (statusText.trim().length > 0) snapshot.statusText = statusText;
		return snapshot;
	} catch (error) {
		return unavailableWorkspaceSnapshot(error instanceof Error ? error.message : String(error));
	}
}

export async function assertWorkflowCheckpointWorkspaceMatches(
	checkpoint: WorkflowCheckpointSnapshot,
	workspaceRoot: string | undefined,
): Promise<void> {
	if (checkpoint.workspace === undefined) return;
	const actual = await captureWorkflowCheckpointWorkspace(workspaceRoot);
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

function unavailableWorkspaceSnapshot(error: string): WorkflowCheckpointWorkspaceSnapshot {
	return {
		kind: "unknown",
		status: "unavailable",
		digest: workspaceDigest(["kind=unknown", `error=${error}`]),
		dirtyPaths: [],
		error,
	};
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
