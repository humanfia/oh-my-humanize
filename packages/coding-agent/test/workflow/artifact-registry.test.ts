import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installWorkflowArtifact,
	listWorkflowFlowSpecs,
	resolveWorkflowFlowSpec,
	uninstallWorkflowArtifact,
} from "../../src/workflow/artifact-registry";
import { freezeWorkflowArtifact } from "../../src/workflow/freeze";
import { loadWorkflowArtifact } from "../../src/workflow/package-loader";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-registry-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow artifact registry", () => {
	it("lists packaged experimental flows only under the experimental namespace", async () => {
		const listed = await listWorkflowFlowSpecs({ cwd: process.cwd(), flowDirs: [] });
		const listedByName = new Map(listed.map(flow => [flow.name, flow]));

		expect(listedByName.get("experimental::humanize-rlcr")).toMatchObject({
			name: "experimental::humanize-rlcr",
			source: "builtin-experimental",
		});
		expect(listedByName.get("experimental::kda-humanize")).toMatchObject({
			name: "experimental::kda-humanize",
			source: "builtin-experimental",
		});
		expect(listedByName.has("humanize-rlcr")).toBe(false);
		expect(listedByName.has("kda-humanize")).toBe(false);
	});

	it("resolves packaged experimental flows by namespace without OMHFLOW_DIR", async () => {
		const spec = await resolveWorkflowFlowSpec("experimental::humanize-rlcr", {
			cwd: process.cwd(),
			flowDirs: [],
		});

		expect(spec).toMatchObject({
			kind: "named",
			input: "experimental::humanize-rlcr",
			name: "experimental::humanize-rlcr",
			source: "builtin-experimental",
		});
		expect(spec.path.endsWith("examples/workflow/experimental/humanize-rlcr/humanize-rlcr.omhflow")).toBe(true);
	});

	it("keeps experimental flows out of stable built-in short-name resolution", async () => {
		for (const name of [
			"humanize-rlcr",
			"kda-humanize",
			"parallel-implementation-review",
			"agent-build-review-loop",
		]) {
			await expect(resolveWorkflowFlowSpec(name, { cwd: process.cwd(), flowDirs: [] })).rejects.toThrow(
				`workflow flow "${name}" was not found`,
			);
		}
	});

	it("keeps demos, candidates, and unverified practical flows out of named built-in resolution", async () => {
		const nonBuiltInNames = [
			"branch-conditional",
			"loop-until-done",
			"parallel-join",
			"human-interactive-dev",
			"recflow-audit-events-cockpit",
			"recflow-lab-audit-events-demo",
			"kda-humanize-reference",
			"parallel-weak-implementation",
			"humanize-rlcr",
			"kda-humanize",
		];
		const listedNames = (await listWorkflowFlowSpecs({ cwd: process.cwd(), flowDirs: [] })).map(spec => spec.name);

		for (const name of nonBuiltInNames) {
			expect(listedNames).not.toContain(name);
			await expect(resolveWorkflowFlowSpec(name, { cwd: process.cwd(), flowDirs: [] })).rejects.toThrow(
				`workflow flow "${name}" was not found`,
			);
		}
	});

	it("treats explicit paths as paths even when the basename matches a candidate flow name", async () => {
		const dir = await createTempDir();
		const flowPath = await writeFlowArtifact(dir, "humanize-rlcr");

		const spec = await resolveWorkflowFlowSpec("./humanize-rlcr.omhflow", { cwd: dir, flowDirs: [] });

		expect(spec).toEqual({ kind: "path", input: "./humanize-rlcr.omhflow", path: flowPath });
	});

	it("keeps infrastructure usable without bundled flow artifacts when a path is supplied", async () => {
		const dir = await createTempDir();
		const missingBuiltinRoot = path.join(dir, "missing-builtins");
		const flowPath = await writeFlowArtifact(dir, "standalone-flow");

		await expect(listWorkflowFlowSpecs({ builtinRoot: missingBuiltinRoot, flowDirs: [] })).resolves.toEqual([]);
		await expect(
			resolveWorkflowFlowSpec(flowPath, { cwd: dir, builtinRoot: missingBuiltinRoot, flowDirs: [] }),
		).resolves.toEqual({ kind: "path", input: flowPath, path: flowPath });
		await expect(freezeWorkflowArtifact(await loadWorkflowArtifact(flowPath))).resolves.toMatchObject({
			definition: { name: "standalone-flow" },
		});
	});

	it("resolves OMHFLOW_DIR names from flat and nested artifact layouts", async () => {
		const flatRoot = await createTempDir();
		const nestedRoot = await createTempDir();
		const flatPath = await writeFlowArtifact(flatRoot, "flat-flow");
		const nestedPath = await writeFlowArtifact(path.join(nestedRoot, "nested-flow"), "nested-flow");

		await expect(resolveWorkflowFlowSpec("flat-flow", { cwd: process.cwd(), flowDirs: [flatRoot] })).resolves.toEqual(
			{
				kind: "named",
				input: "flat-flow",
				name: "flat-flow",
				path: flatPath,
				root: flatRoot,
				source: "omhflow-dir",
			},
		);
		await expect(
			resolveWorkflowFlowSpec("nested-flow", { cwd: process.cwd(), flowDirs: [nestedRoot] }),
		).resolves.toEqual({
			kind: "named",
			input: "nested-flow",
			name: "nested-flow",
			path: nestedPath,
			root: nestedRoot,
			source: "omhflow-dir",
		});
	});

	it("rejects ambiguous external flow names across multiple OMHFLOW_DIR roots", async () => {
		const left = await createTempDir();
		const right = await createTempDir();
		await writeFlowArtifact(path.join(left, "dupe-flow"), "dupe-flow");
		await writeFlowArtifact(path.join(right, "dupe-flow"), "dupe-flow");

		await expect(
			resolveWorkflowFlowSpec("dupe-flow", { cwd: process.cwd(), flowDirs: [left, right] }),
		).rejects.toThrow(/workflow flow "dupe-flow" is ambiguous/);
	});

	it("installs, lists, and uninstalls distributable .omhflow artifacts in the target flow dir", async () => {
		const sourceRoot = await createTempDir();
		const installRoot = await createTempDir();
		const sourcePath = await writeFlowArtifact(sourceRoot, "installed-flow", {
			resourcePath: "prompts/task.md",
			resourceText: "Do the installed task.\n",
		});

		const installed = await installWorkflowArtifact(sourcePath, {
			flowDirs: [installRoot],
		});
		const listed = await listWorkflowFlowSpecs({ flowDirs: [installRoot] });
		const resolved = await resolveWorkflowFlowSpec("installed-flow", { cwd: process.cwd(), flowDirs: [installRoot] });
		const uninstall = await uninstallWorkflowArtifact("installed-flow", { flowDirs: [installRoot] });

		expect(installed).toMatchObject({
			name: "installed-flow",
			path: path.join(installRoot, "installed-flow", "installed-flow.omhflow"),
			root: installRoot,
		});
		expect(listed.map(flow => [flow.name, flow.source])).toContainEqual(["installed-flow", "omhflow-dir"]);
		expect(resolved.path).toBe(installed.path);
		expect(uninstall.path).toBe(installed.path);
		expect(await Bun.file(installed.path).exists()).toBe(false);
	});

	it("reports uninstalled candidate flow names as external lookup misses when no built-in exists", async () => {
		const installRoot = await createTempDir();

		await expect(uninstallWorkflowArtifact("humanize-rlcr", { flowDirs: [installRoot] })).rejects.toThrow(
			'installed workflow flow "humanize-rlcr" was not found',
		);
	});

	it("does not uninstall packaged experimental flows", async () => {
		const installRoot = await createTempDir();

		await expect(
			uninstallWorkflowArtifact("experimental::humanize-rlcr", { flowDirs: [installRoot] }),
		).rejects.toThrow('built-in experimental workflow flow "experimental::humanize-rlcr" cannot be uninstalled');
	});
});

async function writeFlowArtifact(
	root: string,
	name: string,
	options: { resourcePath?: string; resourceText?: string } = {},
): Promise<string> {
	await fs.mkdir(root, { recursive: true });
	const resourceDir = path.join(root, name);
	await fs.mkdir(resourceDir, { recursive: true });
	const resourcePath = options.resourcePath ?? "prompts/task.md";
	const promptPath = path.join(resourceDir, resourcePath);
	await fs.mkdir(path.dirname(promptPath), { recursive: true });
	await Bun.write(promptPath, options.resourceText ?? "Run the workflow task.\n");
	const flowPath = path.join(root, `${name}.omhflow`);
	await Bun.write(
		flowPath,
		[
			"---",
			`name: ${name}`,
			"version: 1",
			"schema: omhflow/v1",
			"models:",
			"  roles: {}",
			"  defaults: {}",
			"checkpoint:",
			"  stopDeadlineMs: 30000",
			"changePolicy:",
			"  agentsCanPropose: true",
			"  humansCanApprove: true",
			"---",
			`# ${name}`,
			"",
			"```yaml workflow",
			"resources:",
			`  - path: ${resourcePath}`,
			"    kind: prompt",
			"nodes:",
			"  - id: task",
			"    type: script",
			"    script:",
			"      language: sh",
			"      inline: 'true'",
			"edges: []",
			"```",
			"",
		].join("\n"),
	);
	return flowPath;
}
