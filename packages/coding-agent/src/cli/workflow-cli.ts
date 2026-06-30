import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, getProjectDir, isEnoent, Snowflake } from "@oh-my-pi/pi-utils";
import { buildWorkflowShellEnvironment } from "../exec/shell-environment-policy";
import type { CustomEntry, SessionEntry } from "../session/session-entries";
import {
	applyEligibleNestedPatches,
	type IsolatedWorktreeResult,
	type IsolationContext,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedWorktree,
} from "../task/isolation-runner";
import {
	installWorkflowArtifact,
	listWorkflowFlowSpecs,
	resolveWorkflowFlowSpec,
	uninstallWorkflowArtifact,
	type WorkflowFlowSpec,
} from "../workflow/artifact-registry";
import type { WorkflowDefinition } from "../workflow/definition";
import { type FlowFreeze, freezeWorkflowArtifact } from "../workflow/freeze";
import type { RuntimeBindingSnapshot } from "../workflow/lifecycle";
import { reconstructWorkflowFamilies } from "../workflow/lifecycle";
import {
	WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK_ENV,
	WORKFLOW_SUBAGENT_MODEL_OVERRIDE_ENV,
	WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV,
	WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV,
} from "../workflow/model-env";
import { WORKFLOW_OBSERVABILITY_INDEX_PATH, WORKFLOW_OBSERVABILITY_PROGRESS_PATH } from "../workflow/observability";
import { loadWorkflowArtifact, WorkflowPackageError } from "../workflow/package-loader";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../workflow/run-store";
import { runWorkflow } from "../workflow/runner";
import { workflowRuntimeBindingUnavailableError } from "../workflow/runtime-binding";
import { DEFAULT_WORKFLOW_MAX_RUNTIME_MS } from "../workflow/runtime-timeout";
import { workflowScriptEnvironment } from "../workflow/script-runtime-env";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowAgentTaskRequest,
	type WorkflowAgentTaskResult,
	type WorkflowShellScriptRequest,
} from "../workflow/session-runtime";

export type WorkflowAction = "list" | "freeze" | "start" | "install" | "uninstall" | "help";

export interface WorkflowCommandArgs {
	action: WorkflowAction;
	args: string[];
	flags: {
		json?: boolean;
		force?: boolean;
		runId?: string;
		familyId?: string;
		startNodeId?: string;
		maxActivations?: number;
		maxNodeActivations?: number;
		maxRuntimeMs?: number;
		cwd?: string;
		background?: boolean;
	};
}

type WorkflowCommandFlagInput = Record<string, string | number | boolean | undefined>;

interface WorkflowStartPackage {
	rootPath: string;
	workflowPath: string;
	definition: WorkflowDefinition;
	freeze?: FlowFreeze;
}

type WorkflowStoreEntry = Pick<CustomEntry, "type" | "customType" | "data"> | SessionEntry;

export interface WorkflowStartSignalTarget {
	once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface HeadlessAgentProcessOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface HeadlessAgentProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type HeadlessAgentProcessRunner = (
	args: string[],
	options: HeadlessAgentProcessOptions,
) => Promise<HeadlessAgentProcessResult>;

export interface HeadlessAgentTaskOptions {
	runProcess?: HeadlessAgentProcessRunner;
	artifactsDir?: string;
}

export interface WorkflowCommandRuntime {
	signalTarget?: WorkflowStartSignalTarget;
	headlessAgentProcess?: HeadlessAgentProcessRunner;
}

interface WorkflowStartSignalController {
	signal: AbortSignal;
	dispose(): void;
}

const ACTIONS = new Set<WorkflowAction>(["list", "freeze", "start", "install", "uninstall", "help"]);

export function resolveWorkflowCommandArgs(
	actionInput: string | undefined,
	argsInput: string[] | undefined,
	flagsInput: WorkflowCommandFlagInput,
): WorkflowCommandArgs {
	const action = normalizeWorkflowAction(actionInput);
	return {
		action,
		args: argsInput ?? [],
		flags: {
			...(flagsInput.json === true ? { json: true } : {}),
			...(flagsInput.force === true ? { force: true } : {}),
			...(typeof flagsInput["run-id"] === "string" ? { runId: flagsInput["run-id"] } : {}),
			...(typeof flagsInput["family-id"] === "string" ? { familyId: flagsInput["family-id"] } : {}),
			...(typeof flagsInput.start === "string" ? { startNodeId: flagsInput.start } : {}),
			...(typeof flagsInput["max-activations"] === "number"
				? { maxActivations: flagsInput["max-activations"] }
				: {}),
			...(typeof flagsInput["max-node-activations"] === "number"
				? { maxNodeActivations: flagsInput["max-node-activations"] }
				: {}),
			...(typeof flagsInput["max-runtime-ms"] === "number" ? { maxRuntimeMs: flagsInput["max-runtime-ms"] } : {}),
			...(typeof flagsInput.cwd === "string" ? { cwd: flagsInput.cwd } : {}),
			...(flagsInput.background === true ? { background: true } : {}),
		},
	};
}

export async function runWorkflowCommand(
	command: WorkflowCommandArgs,
	runtime: WorkflowCommandRuntime = {},
): Promise<void> {
	try {
		switch (command.action) {
			case "list":
				await handleList(command);
				return;
			case "freeze":
				await handleFreeze(command);
				return;
			case "start":
				await handleStart(command, runtime);
				return;
			case "install":
				await handleInstall(command);
				return;
			case "uninstall":
				await handleUninstall(command);
				return;
			case "help":
				handleHelp();
				return;
		}
	} catch (error) {
		writeWorkflowCommandError(error);
	}
}

function normalizeWorkflowAction(actionInput: string | undefined): WorkflowAction {
	if (actionInput === undefined) return "list";
	if (actionInput === "ls") return "list";
	if (ACTIONS.has(actionInput as WorkflowAction)) return actionInput as WorkflowAction;
	throw new Error(`Unknown workflow command: ${actionInput}`);
}

async function handleList(command: WorkflowCommandArgs): Promise<void> {
	const flows = await listWorkflowFlowSpecs();
	if (command.flags.json) {
		writeJson({
			flows: flows.map(flow => ({
				name: flow.name,
				source: flow.source,
				path: flow.path,
				root: flow.root,
			})),
		});
		return;
	}
	if (flows.length === 0) {
		writeLine("No workflow flows found.");
		return;
	}
	writeLine("Workflow flows:");
	for (const flow of flows) {
		writeLine(`- ${flow.name} ${dim(`(${flow.source})`)}`);
	}
}

async function handleFreeze(command: WorkflowCommandArgs): Promise<void> {
	const target = requiredArg(command, "freeze <flow-or-path>");
	const spec = await resolveWorkflowFlowSpec(target, { cwd: command.flags.cwd ?? getProjectDir() });
	const artifact = await loadWorkflowArtifact(spec.path);
	const freeze = await freezeWorkflowArtifact(artifact);
	if (command.flags.json) {
		writeJson({
			flow: flowSpecJson(spec),
			freeze: {
				id: freeze.id,
				graphHash: freeze.canonicalGraphHash,
				resources: freeze.resourceHashes.length,
				nodes: freeze.definition.nodes.length,
			},
		});
		return;
	}
	writeLine(`Workflow freeze: ${freeze.id}`);
	writeLine(`Flow: ${flowLabel(spec)}`);
	writeLine(`Graph: ${freeze.definition.nodes.length} nodes, ${freeze.definition.edges.length} edges`);
	writeLine(`Resources: ${freeze.resourceHashes.length}`);
}

async function handleStart(command: WorkflowCommandArgs, runtime: WorkflowCommandRuntime): Promise<void> {
	const target = requiredArg(command, "start <flow-or-path>");
	const cwd = path.resolve(command.flags.cwd ?? getProjectDir());
	const spec = await resolveWorkflowFlowSpec(target, { cwd });
	const pkg = await loadWorkflowStartPackage(spec.path);
	const startNodeIds =
		command.flags.startNodeId !== undefined
			? [command.flags.startNodeId]
			: defaultWorkflowStartNodeIds(pkg.definition);
	const startNodeId = startNodeIds[0];
	if (!startNodeId) throw new Error("Workflow start requires a workflow with at least one node.");
	const runId = command.flags.runId ?? `workflow-${Date.now()}`;
	const familyId = pkg.freeze ? (command.flags.familyId ?? `${runId}:family`) : undefined;
	const attemptId = familyId !== undefined ? `${runId}:attempt-1` : undefined;
	const host = new InMemoryWorkflowStoreHost();
	const runtimeHost = createSessionWorkflowRuntimeHost({
		cwd,
		runEvalScript: async request => runHeadlessEvalScript(cwd, request.code, request.language),
		runShellScript: async request => runHeadlessShellScript(cwd, request),
		runAgentTask: async request => runHeadlessAgentTask(cwd, request, { runProcess: runtime.headlessAgentProcess }),
	});
	const runtimeBindingSnapshot = createHeadlessRuntimeBindingSnapshot(pkg.definition, `${runId}:binding-1`);
	const bindingError =
		command.flags.maxActivations === 0
			? undefined
			: workflowRuntimeBindingUnavailableError(runtimeBindingSnapshot, pkg.definition, startNodeIds);
	if (bindingError !== undefined) {
		if (command.flags.json) {
			writeJson({ error: bindingError });
		} else {
			writeLine(bindingError);
		}
		return;
	}
	const startSignal = createWorkflowStartSignalController(runtime.signalTarget ?? process);
	const lifecycle =
		pkg.freeze !== undefined && familyId !== undefined && attemptId !== undefined
			? {
					familyId,
					attemptId,
					freeze: pkg.freeze,
					runtimeBindingSnapshot,
				}
			: undefined;
	const result = await runWorkflow({
		host,
		definition: pkg.definition,
		runId,
		startNodeId,
		...(startNodeIds.length > 1 ? { startNodeIds } : {}),
		runtimeHost,
		workspaceRoot: cwd,
		packageRoot: pkg.rootPath,
		...(pkg.freeze !== undefined ? { frozenResources: pkg.freeze.resourceSnapshots } : {}),
		...(command.flags.maxActivations !== undefined ? { maxActivations: command.flags.maxActivations } : {}),
		...(command.flags.maxNodeActivations !== undefined
			? { maxNodeActivations: command.flags.maxNodeActivations }
			: {}),
		signal: startSignal.signal,
		nodeAbortSignal: startSignal.signal,
		maxRuntimeMs: command.flags.maxRuntimeMs ?? DEFAULT_WORKFLOW_MAX_RUNTIME_MS,
		...(lifecycle !== undefined ? { lifecycle } : {}),
	}).finally(() => {
		startSignal.dispose();
	});
	const runs = reconstructWorkflowRuns(host.getBranch());
	const families = reconstructWorkflowFamilies(host.getBranch());
	const failedActivations = result.scheduler.activations.filter(activation => activation.status === "failed");
	const failed = failedActivations[0];
	const lifecycleAttempt =
		attemptId === undefined
			? undefined
			: families.flatMap(family => family.attempts).find(attempt => attempt.id === attemptId);
	const status = failed
		? "failed"
		: lifecycleAttempt?.status === "stopped" || result.scheduler.limitReached
			? "stopped"
			: "completed";
	if (status === "failed") process.exitCode = 1;
	if (command.flags.json) {
		writeJson({
			flow: flowSpecJson(spec),
			run: {
				id: runId,
				status,
				activations: result.scheduler.activations.length,
				completed: result.scheduler.activations.filter(activation => activation.status === "completed").length,
				failed: result.scheduler.activations.filter(activation => activation.status === "failed").length,
				frontier: result.scheduler.frontierNodeIds,
				maxRuntimeMs: command.flags.maxRuntimeMs ?? DEFAULT_WORKFLOW_MAX_RUNTIME_MS,
			},
			failedActivations:
				failedActivations.length > 0
					? failedActivations.map(activation => ({
							id: activation.id,
							nodeId: activation.nodeId,
							error: activation.error ?? activation.reason ?? "workflow activation failed",
						}))
					: undefined,
			diagnostics:
				failedActivations.length > 0
					? {
							progressPath: path.join(cwd, WORKFLOW_OBSERVABILITY_PROGRESS_PATH),
							observabilityPath: path.join(cwd, WORKFLOW_OBSERVABILITY_INDEX_PATH),
						}
					: undefined,
			families: families.map(family => ({
				id: family.id,
				freezes: family.freezes.map(freeze => ({
					id: freeze.id,
					nodes: freeze.definition.nodes.length,
					resources: freeze.resourceHashes.length,
					graphHash: freeze.canonicalGraphHash,
				})),
				attempts: family.attempts.map(attempt => ({
					id: attempt.id,
					status: attempt.status,
					freezeId: attempt.freezeId,
					startNodeId: attempt.startNodeId,
				})),
				checkpoints: family.checkpoints.map(checkpoint => ({
					id: checkpoint.id,
					attemptId: checkpoint.attemptId,
					frontier: checkpoint.frontierNodeIds,
				})),
				changeRequests: family.changeRequests.map(request => ({
					id: request.id,
					status: request.status,
				})),
			})),
			runs: runs.map(run => ({
				id: run.id,
				activations: run.activations.length,
				stateKeys: Object.keys(run.state).sort(),
			})),
		});
		return;
	}
	writeLine(`Workflow run: ${runId}`);
	writeLine(`Flow: ${flowLabel(spec)}`);
	writeLine(`Status: ${status}`);
	writeLine(
		`Activations: ${result.scheduler.activations.length} total, ${result.scheduler.activations.filter(activation => activation.status === "completed").length} completed, ${result.scheduler.activations.filter(activation => activation.status === "failed").length} failed`,
	);
	if (result.scheduler.frontierNodeIds.length > 0) {
		writeLine(`Frontier: ${result.scheduler.frontierNodeIds.join(", ")}`);
	}
	if (failedActivations.length > 0) {
		for (const activation of failedActivations) {
			writeLine(
				`Failed activation: ${activation.nodeId} (${activation.id}) - ${activation.error ?? activation.reason ?? "workflow activation failed"}`,
			);
		}
		writeLine(`Progress: ${path.join(cwd, WORKFLOW_OBSERVABILITY_PROGRESS_PATH)}`);
		writeLine(`Observability: ${path.join(cwd, WORKFLOW_OBSERVABILITY_INDEX_PATH)}`);
	}
}

export function createWorkflowStartSignalController(
	target: WorkflowStartSignalTarget = process,
): WorkflowStartSignalController {
	const controller = new AbortController();
	const abortFrom = (event: "SIGINT" | "SIGTERM"): void => {
		if (!controller.signal.aborted) {
			controller.abort(`workflow interrupted by ${event}`);
		}
	};
	const onSigint = (): void => abortFrom("SIGINT");
	const onSigterm = (): void => abortFrom("SIGTERM");
	target.once("SIGINT", onSigint);
	target.once("SIGTERM", onSigterm);
	return {
		signal: controller.signal,
		dispose: () => {
			target.off("SIGINT", onSigint);
			target.off("SIGTERM", onSigterm);
		},
	};
}

async function handleInstall(command: WorkflowCommandArgs): Promise<void> {
	const source = requiredArg(command, "install <file.omhflow|dir>");
	const installed = await installWorkflowArtifact(source, {
		cwd: command.flags.cwd ?? getProjectDir(),
		force: command.flags.force,
	});
	if (command.flags.json) {
		writeJson({ installed });
		return;
	}
	writeLine(`Installed workflow flow: ${installed.name}`);
	writeLine(`Path: ${installed.path}`);
}

async function handleUninstall(command: WorkflowCommandArgs): Promise<void> {
	const name = requiredArg(command, "uninstall <name>");
	const uninstalled = await uninstallWorkflowArtifact(name);
	if (command.flags.json) {
		writeJson({ uninstalled });
		return;
	}
	writeLine(`Uninstalled workflow flow: ${uninstalled.name}`);
}

function handleHelp(): void {
	writeLine(`${APP_NAME} workflow - Manage and run .omhflow workflow artifacts`);
	writeLine("");
	writeLine(`Usage: ${APP_NAME} workflow <list|freeze|start|install|uninstall> [target] [flags]`);
	writeLine("");
	writeLine("Common commands:");
	writeLine(`  ${APP_NAME} workflow list`);
	writeLine(`  ${APP_NAME} workflow start experimental::humanize-rlcr --max-activations 1`);
	writeLine(`  ${APP_NAME} workflow freeze experimental::humanize-rlcr --json`);
	writeLine(`  ${APP_NAME} workflow install ./my-flow.omhflow`);
	writeLine("");
	writeLine(`Run ${APP_NAME} workflow --help for flags and examples.`);
}

export function writeWorkflowCommandError(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	writeError(`${withWorkflowCommandRecoveryHint(message)}\n`);
	process.exitCode = 1;
}

function withWorkflowCommandRecoveryHint(message: string): string {
	if (message.startsWith("Expected action to be one of:")) {
		return `${message}\nHeadless workflow commands support list, freeze, start, install, and uninstall. Run ${APP_NAME} workflow help.`;
	}
	if (message.startsWith("Unknown workflow command: run")) {
		return `${message}\nDid you mean ${APP_NAME} workflow start? Run ${APP_NAME} workflow help.`;
	}
	if (message.startsWith("Unknown workflow command:")) {
		return `${message}\nRun ${APP_NAME} workflow help for supported commands.`;
	}
	return message;
}

async function loadWorkflowStartPackage(workflowPath: string): Promise<WorkflowStartPackage> {
	if (path.extname(workflowPath) !== ".omhflow") {
		throw new WorkflowPackageError(
			"Workflow start requires a frozen .omhflow artifact; use a distributable <flow>.omhflow file and same-name resource directory.",
		);
	}
	const artifact = await loadWorkflowArtifact(workflowPath);
	const freeze = await freezeWorkflowArtifact(artifact);
	return {
		rootPath: freeze.resourceDir,
		workflowPath: freeze.flowPath,
		definition: freeze.definition,
		freeze,
	};
}

function defaultWorkflowStartNodeIds(definition: WorkflowStartPackage["definition"]): string[] {
	const incomingNodeIds = new Set(definition.edges.map(edge => edge.to));
	const roots = definition.nodes.filter(node => !incomingNodeIds.has(node.id)).map(node => node.id);
	const fallback = definition.nodes[0]?.id;
	return roots.length > 0 ? roots : fallback !== undefined ? [fallback] : [];
}

function createHeadlessRuntimeBindingSnapshot(
	definition: WorkflowStartPackage["definition"],
	id: string,
): RuntimeBindingSnapshot {
	const tools = new Set<string>();
	const agents = new Set<string>();
	for (const node of definition.nodes) {
		if (node.type === "script") tools.add(node.script?.language === "sh" ? "bash" : "eval");
		if (node.type === "human") tools.add("ask");
		if (node.type === "agent" || node.type === "review") tools.add("task");
		if (node.agent) agents.add(node.agent);
	}
	for (const tool of definition.capabilities?.tools ?? []) tools.add(tool);
	for (const agent of definition.capabilities?.agents ?? []) agents.add(agent);
	return {
		id,
		requestedRoles: { ...definition.models.roles },
		resolvedModels: {},
		tools: [...tools].sort(),
		agents: [...agents].sort(),
		plugins: [...(definition.capabilities?.plugins ?? [])].sort(),
		extensions: [...(definition.capabilities?.extensions ?? [])].sort(),
		skills: [...(definition.capabilities?.skills ?? [])].sort(),
		unavailable: definition.nodes.some(node => node.type === "human")
			? ["tool:ask: headless workflow CLI cannot answer human nodes"]
			: [],
		warnings: definition.nodes.some(node => node.type === "human")
			? ["headless workflow CLI cannot answer human nodes; use interactive /workflow start for those flows"]
			: [],
	};
}

async function runHeadlessEvalScript(
	cwd: string,
	code: string,
	language: "js" | "py",
): Promise<{ exitCode: number; output: string; error?: string; language: "js" | "py" }> {
	if (language === "py") {
		return { exitCode: 1, output: "", error: "headless workflow CLI does not support py eval scripts", language };
	}
	const previousCwd = process.cwd();
	const originalConsoleLog = console.log;
	const capturedOutput: string[] = [];
	try {
		process.chdir(cwd);
		console.log = (...data: unknown[]) => {
			capturedOutput.push(data.map(formatConsoleArgument).join(" "));
		};
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
			code: string,
		) => () => Promise<unknown>;
		const execute = new AsyncFunction(code);
		const result = await execute();
		const formattedResult = formatScriptValue(result);
		if (formattedResult) capturedOutput.push(formattedResult);
		return { exitCode: 0, output: capturedOutput.join("\n"), language };
	} catch (error) {
		return { exitCode: 1, output: "", error: errorMessage(error), language };
	} finally {
		console.log = originalConsoleLog;
		process.chdir(previousCwd);
	}
}

async function runHeadlessShellScript(
	cwd: string,
	request: WorkflowShellScriptRequest,
): Promise<{ exitCode: number; output: string; error?: string; language: "sh" }> {
	const child = Bun.spawn(["sh", "-c", request.code], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: request.signal,
		env: buildWorkflowShellEnvironment(workflowScriptEnvironment(request)),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		streamText(child.stdout),
		streamText(child.stderr),
		child.exited,
	]);
	const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
	return {
		exitCode,
		output,
		...(exitCode === 0 ? {} : { error: stderr.trim() || `exit code ${exitCode}` }),
		language: "sh",
	};
}

interface HeadlessIsolatedAgentTaskResult extends WorkflowAgentTaskResult, IsolatedWorktreeResult {
	id: string;
	description?: string;
	output: string;
}

export async function runHeadlessAgentTask(
	cwd: string,
	request: WorkflowAgentTaskRequest,
	options: HeadlessAgentTaskOptions = {},
): Promise<WorkflowAgentTaskResult> {
	if (request.isolated !== true) {
		return runHeadlessAgentTaskProcess(cwd, request, options);
	}
	const agentId = headlessWorkflowAgentId(request);
	const artifactsDir = options.artifactsDir ?? path.join(os.tmpdir(), `omh-workflow-agent-${Snowflake.next()}`);
	const tempArtifactsDir = options.artifactsDir === undefined ? artifactsDir : undefined;
	let isolationContext: IsolationContext;
	try {
		isolationContext = await prepareIsolationContext(cwd, request.capture);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			exitCode: 1,
			output: "",
			stderr: message,
			error: `Isolated workflow agent execution requires a git repository. ${message}`,
		};
	}
	const mergeMode: "patch" = "patch";
	const result = await runIsolatedWorktree<HeadlessIsolatedAgentTaskResult>({
		context: isolationContext,
		preferredBackend: undefined,
		agentId,
		mergeMode,
		artifactsDir,
		capture: request.capture,
		description: request.task.description,
		buildFailureResult: err => {
			const message = err instanceof Error ? err.message : String(err);
			return {
				id: agentId,
				agentId,
				exitCode: 1,
				output: "",
				stderr: message,
				error: message,
				description: request.task.description,
			};
		},
		run: async isolationDir => {
			const processResult = await runHeadlessAgentTaskProcess(isolationDir, request, {
				...options,
				artifactsDir,
			});
			return {
				...processResult,
				id: agentId,
				agentId,
				description: request.task.description,
			};
		},
	});
	let changesApplied: boolean | null | undefined;
	if (request.apply === false) {
		changesApplied = null;
	} else {
		const outcome = await mergeIsolatedChanges({ result, repoRoot: isolationContext.repoRoot, mergeMode });
		changesApplied = outcome.changesApplied;
		await applyEligibleNestedPatches({
			result,
			repoRoot: isolationContext.repoRoot,
			mergeMode,
			changesApplied,
			mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
		});
	}
	if (tempArtifactsDir !== undefined && changesApplied === true) {
		await fs.rm(tempArtifactsDir, { recursive: true, force: true });
	}
	return {
		exitCode: result.exitCode,
		output: result.output,
		...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
		...(result.error !== undefined ? { error: result.error } : {}),
		agentId,
		...(result.outputPath !== undefined ? { outputPath: result.outputPath } : {}),
		...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
		...(result.patchPath !== undefined ? { patchPath: result.patchPath } : {}),
		...(result.branchName !== undefined ? { branchName: result.branchName } : {}),
		...(changesApplied !== undefined ? { changesApplied } : {}),
	};
}

async function runHeadlessAgentTaskProcess(
	cwd: string,
	request: WorkflowAgentTaskRequest,
	options: HeadlessAgentTaskOptions = {},
): Promise<WorkflowAgentTaskResult> {
	const agentId = headlessWorkflowAgentId(request);
	const artifactsDir = options.artifactsDir ?? path.join(os.tmpdir(), `omh-workflow-agent-${Snowflake.next()}`);
	const agentArtifactsDir = path.join(artifactsDir, agentId);
	const sessionDir = path.join(agentArtifactsDir, "sessions");
	const outputPath = path.join(agentArtifactsDir, "output.md");
	await fs.mkdir(sessionDir, { recursive: true });
	const args = buildHeadlessAgentTaskArgs(cwd, request.task.assignment, request.modelOverride, sessionDir);
	const runProcess = options.runProcess ?? spawnHeadlessAgentTaskProcess;
	const { stdout, stderr, exitCode } = await runProcess(args, {
		cwd,
		signal: request.signal,
		env: buildHeadlessAgentTaskEnv(Bun.env, request.modelOverride, request.modelOverrideAuthFallback),
	});
	await Bun.write(outputPath, stdout);
	const sessionFile = await latestHeadlessAgentSessionFile(sessionDir);
	return {
		exitCode,
		output: stdout.trim(),
		...(stderr.trim() ? { stderr: stderr.trim() } : {}),
		...(exitCode === 0 ? {} : { error: stderr.trim() || `exit code ${exitCode}` }),
		agentId,
		outputPath,
		...(sessionFile !== undefined ? { sessionFile } : {}),
	};
}

async function spawnHeadlessAgentTaskProcess(
	args: string[],
	options: HeadlessAgentProcessOptions,
): Promise<HeadlessAgentProcessResult> {
	const child = Bun.spawn(args, {
		cwd: options.cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: options.signal,
		env: options.env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		streamText(child.stdout),
		streamText(child.stderr),
		child.exited,
	]);
	return {
		exitCode,
		stdout,
		stderr,
	};
}

function headlessWorkflowAgentId(request: WorkflowAgentTaskRequest): string {
	return `workflow-${sanitizeHeadlessAgentIdSegment(`${request.task.id}-${request.activationId}`)}`;
}

function sanitizeHeadlessAgentIdSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || Snowflake.next();
}

export function buildHeadlessAgentTaskArgs(
	cwd: string,
	assignment: string,
	modelOverride?: string,
	sessionDir?: string,
): string[] {
	const args = [...currentCliInvocation(), "launch", "--cwd", cwd];
	if (modelOverride !== undefined) args.push("--model", modelOverride);
	if (sessionDir !== undefined) args.push("--session-dir", sessionDir);
	args.push("-p", assignment);
	return args;
}

async function latestHeadlessAgentSessionFile(sessionDir: string): Promise<string | undefined> {
	let entries: string[];
	try {
		entries = await fs.readdir(sessionDir);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const jsonlEntries = entries.filter(entry => entry.endsWith(".jsonl")).sort();
	const latest = jsonlEntries[jsonlEntries.length - 1];
	return latest === undefined ? undefined : path.join(sessionDir, latest);
}

export function buildHeadlessAgentTaskEnv(
	env: NodeJS.ProcessEnv,
	modelOverride: string | undefined,
	modelOverrideAuthFallback: boolean | undefined,
): NodeJS.ProcessEnv {
	const workflowEnv = {
		...env,
		[WORKFLOW_SUBAGENT_RETRY_BASE_DELAY_MS_ENV]: "30000",
		[WORKFLOW_SUBAGENT_RETRY_MAX_DELAY_MS_ENV]: "300000",
	};
	if (modelOverride === undefined) return workflowEnv;
	return {
		...workflowEnv,
		[WORKFLOW_SUBAGENT_MODEL_OVERRIDE_ENV]: modelOverride,
		[WORKFLOW_SUBAGENT_MODEL_OVERRIDE_AUTH_FALLBACK_ENV]: modelOverrideAuthFallback === false ? "false" : "true",
	};
}

function currentCliInvocation(): string[] {
	if (Bun.main === process.execPath) return [process.execPath];
	return [process.execPath, Bun.main];
}

async function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (stream === null) return "";
	return new Response(stream).text();
}

function formatScriptValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function formatConsoleArgument(value: unknown): string {
	if (typeof value === "string") return value;
	return formatScriptValue(value);
}

function requiredArg(command: WorkflowCommandArgs, usage: string): string {
	const value = command.args[0];
	if (!value) throw new Error(`Usage: ${APP_NAME} workflow ${usage}`);
	return value;
}

function flowSpecJson(spec: WorkflowFlowSpec): Record<string, string> {
	if (spec.kind === "path") return { kind: spec.kind, path: spec.path };
	return { kind: spec.kind, name: spec.name, source: spec.source, path: spec.path, root: spec.root };
}

function flowLabel(spec: WorkflowFlowSpec): string {
	if (spec.kind === "path") return spec.path;
	return `${spec.name} (${spec.source})`;
}

class InMemoryWorkflowStoreHost implements WorkflowRunStoreHost {
	#entries: WorkflowStoreEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		this.#entries.push({ type: "custom", customType, data });
		return `entry-${this.#entries.length}`;
	}

	getBranch(): WorkflowStoreEntry[] {
		return this.#entries;
	}
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function writeJson(value: unknown): void {
	writeLine(JSON.stringify(value));
}

function writeError(line: string): void {
	process.stderr.write(line);
}

function dim(value: string): string {
	return process.stdout.isTTY ? `\u001b[2m${value}\u001b[22m` : value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
