import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../../config/model-resolver";
import { parseCommandArgs } from "../../utils/command-args";
import type { WorkflowDefinition } from "../../workflow/definition";
import { type FlowFreeze, freezeWorkflowArtifact } from "../../workflow/freeze";
import {
	buildWorkflowInspection,
	buildWorkflowLifecycleInspection,
	type WorkflowInspection,
	type WorkflowLifecycleInspection,
} from "../../workflow/inspection";
import {
	appendWorkflowAttemptActivationAborted,
	approveWorkflowChangeRequest,
	createWorkflowCheckpoint,
	type ProposeWorkflowChangeRequestOptions,
	proposeWorkflowChangeRequest,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	recordWorkflowFreeze,
	rejectWorkflowChangeRequest,
	requestWorkflowAttemptStop,
	startWorkflowFamily,
	type WorkflowChangeRequestOrigin,
	type WorkflowCheckpointSnapshot,
	type WorkflowRunFamilySnapshot,
} from "../../workflow/lifecycle";
import { loadWorkflowArtifact, loadWorkflowPackage } from "../../workflow/package-loader";
import type { WorkflowGraphPatchOperation } from "../../workflow/patches";
import { reconstructWorkflowRuns } from "../../workflow/run-store";
import { runWorkflow, type WorkflowRunnerModelResolutionOptions } from "../../workflow/runner";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

interface WorkflowStartArgs {
	workflowPath: string;
	runId?: string;
	startNodeId?: string;
	familyId?: string;
}

interface WorkflowStopArgs {
	attemptId: string;
	deadlineMs?: number;
}

interface WorkflowRestartArgs {
	checkpointId: string;
	freezeId?: string;
}

interface WorkflowFreezeArgs {
	workflowPath: string;
	familyId?: string;
}

interface WorkflowRequestChangeArgs {
	filePath: string;
	familyId?: string;
	attemptId?: string;
}

interface WorkflowApproveChangeArgs {
	changeRequestId: string;
	actor?: string;
}

interface WorkflowRejectChangeArgs {
	changeRequestId: string;
	actor?: string;
	reason?: string;
}

interface WorkflowListArgs {
	familyId?: string;
}

interface WorkflowStartPackage {
	rootPath: string;
	workflowPath: string;
	definition: WorkflowDefinition;
	freeze?: FlowFreeze;
}

export async function handleWorkflowAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "inspect") {
		return handleInspectCommand(runtime);
	}
	if (verb === "list") {
		return handleListCommand(rest, runtime);
	}
	if (verb === "start") {
		return handleStartCommand(rest, runtime);
	}
	if (verb === "freeze") {
		return handleFreezeCommand(rest, runtime);
	}
	if (verb === "request-change") {
		return handleRequestChangeCommand(rest, runtime);
	}
	if (verb === "approve-change") {
		return handleApproveChangeCommand(rest, runtime);
	}
	if (verb === "reject-change") {
		return handleRejectChangeCommand(rest, runtime);
	}
	if (verb === "stop") {
		return handleStopCommand(rest, runtime);
	}
	if (verb === "restart") {
		return handleRestartCommand(rest, runtime);
	}
	return usage(workflowUsage(), runtime);
}

async function handleInspectCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const branch = runtime.sessionManager.getBranch();
	const runs = reconstructWorkflowRuns(branch);
	const families = reconstructWorkflowFamilies(branch);
	const run = runs.at(-1);
	if (!run && families.length === 0) {
		await runtime.output("No workflow runs or workflow families found.");
		return commandConsumed();
	}
	const sections: string[] = [];
	if (run) sections.push(formatWorkflowInspection(buildWorkflowInspection(run)));
	if (families.length > 0) {
		sections.push(
			...families.map(family => formatWorkflowLifecycleInspection(buildWorkflowLifecycleInspection(family))),
		);
	}
	await runtime.output(sections.join("\n\n"));
	return commandConsumed();
}

async function handleListCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowListArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	if (parsed.familyId !== undefined) families = families.filter(family => family.id === parsed.familyId);
	if (families.length === 0) {
		await runtime.output(
			parsed.familyId ? `Workflow family not found: ${parsed.familyId}` : "No workflow families found.",
		);
		return commandConsumed();
	}
	await runtime.output(formatWorkflowLifecycleList(families));
	return commandConsumed();
}

async function handleStartCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowStartArgs(rest);
	if ("error" in parsed) {
		return usage(parsed.error, runtime);
	}
	if (!runtime.createWorkflowRuntimeHost) {
		return usage("Workflow start requires a workflow runtime host.", runtime);
	}
	const pkg = await loadWorkflowStartPackage(resolveWorkflowPath(parsed.workflowPath, runtime.cwd));
	const startNodeId = parsed.startNodeId ?? pkg.definition.nodes[0]?.id;
	if (!startNodeId) {
		return usage("Workflow start requires a workflow with at least one node.", runtime);
	}
	const runId = parsed.runId ?? `workflow-${Snowflake.next()}`;
	await runWorkflow({
		host: runtime.sessionManager,
		definition: pkg.definition,
		runId,
		startNodeId,
		runtimeHost: await runtime.createWorkflowRuntimeHost(),
		packageRoot: pkg.rootPath,
		modelResolution: createWorkflowModelResolution(runtime),
		lifecycle: pkg.freeze
			? {
					familyId: parsed.familyId ?? `${runId}:family`,
					attemptId: `${runId}:attempt-1`,
					freeze: pkg.freeze,
					runtimeBindingSnapshot: createRuntimeBindingSnapshot(pkg.definition, `${runId}:binding-1`),
				}
			: undefined,
	});
	const run = reconstructWorkflowRuns(runtime.sessionManager.getBranch()).find(candidate => candidate.id === runId);
	if (!run) {
		await runtime.output(`Workflow run ${runId} started, but no run records were found.`);
		return commandConsumed();
	}
	await runtime.output(formatWorkflowInspection(buildWorkflowInspection(run)));
	return commandConsumed();
}

async function handleFreezeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowFreezeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const artifact = await loadWorkflowArtifact(resolveWorkflowPath(parsed.workflowPath, runtime.cwd));
	const freeze = await freezeWorkflowArtifact(artifact);
	const familyId = parsed.familyId ?? `${freeze.id}:family`;
	startWorkflowFamily(runtime.sessionManager, { familyId });
	recordWorkflowFreeze(runtime.sessionManager, freeze, { familyId });
	await runtime.output(`Workflow freeze: ${freeze.id}\nFamily: ${familyId}`);
	return commandConsumed();
}

async function handleRequestChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowRequestChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const request = await readWorkflowChangeRequest(resolveWorkflowPath(parsed.filePath, runtime.cwd), parsed);
	proposeWorkflowChangeRequest(runtime.sessionManager, request);
	await runtime.output(`Workflow change request: ${request.changeRequestId}\nStatus: proposed`);
	return commandConsumed();
}

async function handleApproveChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowApproveChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	approveWorkflowChangeRequest(runtime.sessionManager, {
		changeRequestId: parsed.changeRequestId,
		actor: parsed.actor ?? "human",
		reason: "slash command approval",
	});
	await runtime.output(`Workflow change request approved: ${parsed.changeRequestId}`);
	return commandConsumed();
}

async function handleRejectChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowRejectChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	rejectWorkflowChangeRequest(runtime.sessionManager, {
		changeRequestId: parsed.changeRequestId,
		actor: parsed.actor ?? "human",
		reason: parsed.reason,
	});
	await runtime.output(`Workflow change request rejected: ${parsed.changeRequestId}`);
	return commandConsumed();
}

async function handleStopCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowStopArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const family = families.find(candidate => candidate.attempts.some(attempt => attempt.id === parsed.attemptId));
	const attempt = family?.attempts.find(candidate => candidate.id === parsed.attemptId);
	if (!family || !attempt) return usage(`Workflow attempt not found: ${parsed.attemptId}`, runtime);
	const checkpointId = `${attempt.id}:checkpoint-${family.checkpoints.length + 1}`;
	const runningActivations = attempt.activations.filter(activation => activation.status === "running");
	requestWorkflowAttemptStop(runtime.sessionManager, {
		attemptId: attempt.id,
		deadlineMs: parsed.deadlineMs ?? 30_000,
		reason: "slash command stop",
	});
	for (const activation of runningActivations) {
		appendWorkflowAttemptActivationAborted(runtime.sessionManager, {
			attemptId: attempt.id,
			activationId: activation.id,
			nodeId: activation.nodeId,
			reason: "stop requested",
		});
	}
	const completedActivationIds = attempt.activations
		.filter(activation => activation.status === "completed")
		.map(activation => activation.id);
	const abortedActivationIds = runningActivations.map(activation => activation.id);
	const frontierNodeIds = runningActivations.map(activation => activation.nodeId);
	const checkpoint = createWorkflowCheckpoint(runtime.sessionManager, {
		checkpointId,
		familyId: family.id,
		attemptId: attempt.id,
		completedActivationIds,
		abortedActivationIds,
		frontierNodeIds,
		state: {},
		sourceMapping: Object.fromEntries(frontierNodeIds.map(nodeId => [nodeId, nodeId])),
	});
	await runtime.output(formatWorkflowCheckpoint(checkpoint));
	return commandConsumed();
}

async function handleRestartCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowRestartArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const located = findCheckpoint(families, parsed.checkpointId);
	if (!located) return usage(`Workflow checkpoint not found: ${parsed.checkpointId}`, runtime);
	const freeze =
		parsed.freezeId !== undefined
			? located.family.freezes.find(candidate => candidate.id === parsed.freezeId)
			: located.family.freezes.at(-1);
	if (!freeze) return usage(`Workflow freeze not found: ${parsed.freezeId ?? "latest"}`, runtime);
	const startNodeId = resolveRestartStartNode(located.checkpoint, freeze.definition);
	if (!startNodeId) return usage(`Workflow checkpoint has no restartable frontier: ${parsed.checkpointId}`, runtime);
	const attemptId = `attempt-${located.family.attempts.length + 1}`;
	if (!runtime.createWorkflowRuntimeHost) {
		return usage("Workflow restart requires a workflow runtime host.", runtime);
	}
	await runWorkflow({
		host: runtime.sessionManager,
		definition: freeze.definition,
		runId: `${attemptId}:run`,
		startNodeId,
		runtimeHost: await runtime.createWorkflowRuntimeHost(),
		packageRoot: freeze.resourceDir,
		initialState: located.checkpoint.state,
		modelResolution: createWorkflowModelResolution(runtime),
		lifecycle: {
			familyId: located.family.id,
			attemptId,
			checkpointId: located.checkpoint.id,
			freeze,
			runtimeBindingSnapshot: createRuntimeBindingSnapshot(freeze.definition, `${attemptId}:binding-1`),
			recordFamily: false,
			recordFreeze: false,
		},
	});
	await runtime.output(`Workflow restart attempt: ${attemptId}`);
	return commandConsumed();
}

async function loadWorkflowStartPackage(workflowPath: string): Promise<WorkflowStartPackage> {
	if (path.extname(workflowPath) === ".omhflow") {
		const artifact = await loadWorkflowArtifact(workflowPath);
		const freeze = await freezeWorkflowArtifact(artifact);
		return {
			rootPath: freeze.resourceDir,
			workflowPath: freeze.flowPath,
			definition: freeze.definition,
			freeze,
		};
	}
	return loadWorkflowPackage(workflowPath);
}

function parseWorkflowStartArgs(rest: string): WorkflowStartArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let workflowPath: string | undefined;
	let runId: string | undefined;
	let startNodeId: string | undefined;
	let familyId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--run-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			runId = value;
			index += 1;
			continue;
		}
		if (token === "--start") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			startNodeId = value;
			index += 1;
			continue;
		}
		if (token === "--family-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			familyId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return { error: `Unknown workflow start option: ${token}\n${workflowUsage()}` };
		}
		if (workflowPath !== undefined) {
			return { error: `Unexpected workflow start argument: ${token}\n${workflowUsage()}` };
		}
		workflowPath = token;
	}
	if (!workflowPath) {
		return { error: workflowUsage() };
	}
	const args: WorkflowStartArgs = { workflowPath };
	if (runId !== undefined) args.runId = runId;
	if (startNodeId !== undefined) args.startNodeId = startNodeId;
	if (familyId !== undefined) args.familyId = familyId;
	return args;
}

function parseWorkflowListArgs(rest: string): WorkflowListArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let familyId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--family-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			familyId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown workflow list option: ${token}\n${workflowUsage()}` };
		return { error: `Unexpected workflow list argument: ${token}\n${workflowUsage()}` };
	}
	const args: WorkflowListArgs = {};
	if (familyId !== undefined) args.familyId = familyId;
	return args;
}

function parseWorkflowFreezeArgs(rest: string): WorkflowFreezeArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let workflowPath: string | undefined;
	let familyId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--family-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			familyId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown workflow freeze option: ${token}\n${workflowUsage()}` };
		if (workflowPath !== undefined)
			return { error: `Unexpected workflow freeze argument: ${token}\n${workflowUsage()}` };
		workflowPath = token;
	}
	if (!workflowPath) return { error: workflowUsage() };
	const args: WorkflowFreezeArgs = { workflowPath };
	if (familyId !== undefined) args.familyId = familyId;
	return args;
}

function parseWorkflowRequestChangeArgs(rest: string): WorkflowRequestChangeArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let filePath: string | undefined;
	let familyId: string | undefined;
	let attemptId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--family-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			familyId = value;
			index += 1;
			continue;
		}
		if (token === "--attempt-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			attemptId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return { error: `Unknown workflow request-change option: ${token}\n${workflowUsage()}` };
		}
		if (filePath !== undefined) {
			return { error: `Unexpected workflow request-change argument: ${token}\n${workflowUsage()}` };
		}
		filePath = token;
	}
	if (!filePath) return { error: workflowUsage() };
	const args: WorkflowRequestChangeArgs = { filePath };
	if (familyId !== undefined) args.familyId = familyId;
	if (attemptId !== undefined) args.attemptId = attemptId;
	return args;
}

function parseWorkflowApproveChangeArgs(rest: string): WorkflowApproveChangeArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let changeRequestId: string | undefined;
	let actor: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--actor") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			actor = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) {
			return { error: `Unknown workflow approve-change option: ${token}\n${workflowUsage()}` };
		}
		if (changeRequestId !== undefined) {
			return { error: `Unexpected workflow approve-change argument: ${token}\n${workflowUsage()}` };
		}
		changeRequestId = token;
	}
	if (!changeRequestId) return { error: workflowUsage() };
	const args: WorkflowApproveChangeArgs = { changeRequestId };
	if (actor !== undefined) args.actor = actor;
	return args;
}

function parseWorkflowRejectChangeArgs(rest: string): WorkflowRejectChangeArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let changeRequestId: string | undefined;
	let actor: string | undefined;
	let reason: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--actor") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			actor = value;
			index += 1;
			continue;
		}
		if (token === "--reason") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			reason = tokens.slice(index + 1).join(" ");
			break;
		}
		if (token.startsWith("--")) {
			return { error: `Unknown workflow reject-change option: ${token}\n${workflowUsage()}` };
		}
		if (changeRequestId !== undefined) {
			return { error: `Unexpected workflow reject-change argument: ${token}\n${workflowUsage()}` };
		}
		changeRequestId = token;
	}
	if (!changeRequestId) return { error: workflowUsage() };
	const args: WorkflowRejectChangeArgs = { changeRequestId };
	if (actor !== undefined) args.actor = actor;
	if (reason !== undefined) args.reason = reason;
	return args;
}

function parseWorkflowStopArgs(rest: string): WorkflowStopArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let attemptId: string | undefined;
	let deadlineMs: number | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--deadline-ms") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed < 0)
				return { error: "Workflow stop deadline must be a non-negative number." };
			deadlineMs = parsed;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown workflow stop option: ${token}\n${workflowUsage()}` };
		if (attemptId !== undefined) return { error: `Unexpected workflow stop argument: ${token}\n${workflowUsage()}` };
		attemptId = token;
	}
	if (!attemptId) return { error: workflowUsage() };
	const args: WorkflowStopArgs = { attemptId };
	if (deadlineMs !== undefined) args.deadlineMs = deadlineMs;
	return args;
}

function parseWorkflowRestartArgs(rest: string): WorkflowRestartArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let checkpointId: string | undefined;
	let freezeId: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--freeze-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			freezeId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown workflow restart option: ${token}\n${workflowUsage()}` };
		if (checkpointId !== undefined)
			return { error: `Unexpected workflow restart argument: ${token}\n${workflowUsage()}` };
		checkpointId = token;
	}
	if (!checkpointId) return { error: workflowUsage() };
	const args: WorkflowRestartArgs = { checkpointId };
	if (freezeId !== undefined) args.freezeId = freezeId;
	return args;
}

function resolveWorkflowPath(workflowPath: string, cwd: string): string {
	return path.isAbsolute(workflowPath) ? workflowPath : path.resolve(cwd, workflowPath);
}

function createWorkflowModelResolution(runtime: SlashCommandRuntime): WorkflowRunnerModelResolutionOptions | undefined {
	const availableModels =
		runtime.session.getAvailableModels?.() ?? runtime.session.modelRegistry?.getAvailable?.() ?? [];
	if (availableModels.length === 0) return undefined;
	return {
		availableModels,
		settings: runtime.settings,
		modelRegistry: runtime.session.modelRegistry,
		parentActiveModelPattern: runtime.session.model ? formatModelString(runtime.session.model) : undefined,
	};
}

function createRuntimeBindingSnapshot(definition: WorkflowDefinition, id: string): RuntimeBindingSnapshot {
	const tools = new Set<string>();
	const agents = new Set<string>();
	for (const node of definition.nodes) {
		if (node.type === "script") tools.add("eval");
		if (node.type === "human") tools.add("ask");
		if (node.type === "agent" || node.type === "review") tools.add("task");
		if (node.agent) agents.add(node.agent);
	}
	return {
		id,
		requestedRoles: { ...definition.models.roles },
		resolvedModels: { ...definition.models.roles },
		tools: [...tools].sort(),
		agents: [...agents].sort(),
		unavailable: [],
		warnings: [],
	};
}

function findCheckpoint(
	families: WorkflowRunFamilySnapshot[],
	checkpointId: string,
): { family: WorkflowRunFamilySnapshot; checkpoint: WorkflowCheckpointSnapshot } | undefined {
	for (const family of families) {
		const checkpoint = family.checkpoints.find(candidate => candidate.id === checkpointId);
		if (checkpoint) return { family, checkpoint };
	}
	return undefined;
}

function resolveRestartStartNode(
	checkpoint: WorkflowCheckpointSnapshot,
	definition: WorkflowDefinition,
): string | undefined {
	const nodeIds = new Set(definition.nodes.map(node => node.id));
	for (const frontierNodeId of checkpoint.frontierNodeIds) {
		const mapped = checkpoint.sourceMapping[frontierNodeId] ?? frontierNodeId;
		if (nodeIds.has(mapped)) return mapped;
	}
	return undefined;
}

function formatWorkflowCheckpoint(checkpoint: WorkflowCheckpointSnapshot): string {
	return [
		`Workflow checkpoint: ${checkpoint.id}`,
		`Attempt: ${checkpoint.attemptId}`,
		`Completed activations: ${checkpoint.completedActivationIds.length}`,
		`Aborted activations: ${checkpoint.abortedActivationIds.length}`,
		`Frontier: ${checkpoint.frontierNodeIds.join(", ") || "none"}`,
	].join("\n");
}

interface WorkflowChangeRequestFile {
	id?: string;
	familyId?: string;
	attemptId?: string;
	checkpointId?: string;
	actor?: string;
	origin?: WorkflowChangeRequestOrigin;
	reason?: string;
	operations?: WorkflowGraphPatchOperation[];
	frontierMapping?: Record<string, string>;
}

async function readWorkflowChangeRequest(
	filePath: string,
	args: WorkflowRequestChangeArgs,
): Promise<ProposeWorkflowChangeRequestOptions> {
	const raw = await Bun.file(filePath).json();
	const file = parseWorkflowChangeRequestFile(raw, filePath);
	const familyId = args.familyId ?? file.familyId;
	if (!familyId) throw new Error(`${filePath}: workflow change request requires familyId`);
	const request: ProposeWorkflowChangeRequestOptions = {
		changeRequestId: file.id ?? `change-${Snowflake.next()}`,
		familyId,
		actor: file.actor ?? "external",
		origin: file.origin ?? "slash-command",
		reason: file.reason ?? "slash command change request",
		operations: file.operations ?? [],
		frontierMapping: file.frontierMapping ?? {},
	};
	const attemptId = args.attemptId ?? file.attemptId;
	if (attemptId !== undefined) request.attemptId = attemptId;
	if (file.checkpointId !== undefined) request.checkpointId = file.checkpointId;
	return request;
}

function parseWorkflowChangeRequestFile(value: unknown, filePath: string): WorkflowChangeRequestFile {
	if (!isRecord(value)) throw new Error(`${filePath}: workflow change request must be a JSON object`);
	const file: WorkflowChangeRequestFile = {};
	if (typeof value.id === "string") file.id = value.id;
	if (typeof value.familyId === "string") file.familyId = value.familyId;
	if (typeof value.attemptId === "string") file.attemptId = value.attemptId;
	if (typeof value.checkpointId === "string") file.checkpointId = value.checkpointId;
	if (typeof value.actor === "string") file.actor = value.actor;
	if (isWorkflowChangeRequestOrigin(value.origin)) file.origin = value.origin;
	if (typeof value.reason === "string") file.reason = value.reason;
	if (Array.isArray(value.operations)) file.operations = value.operations.map(parseWorkflowGraphPatchOperation);
	if (isStringRecord(value.frontierMapping)) file.frontierMapping = value.frontierMapping;
	return file;
}

function parseWorkflowGraphPatchOperation(value: unknown): WorkflowGraphPatchOperation {
	if (!isRecord(value) || typeof value.op !== "string") {
		throw new Error("workflow change request operation must be an object with an op string");
	}
	return value as unknown as WorkflowGraphPatchOperation;
}

function isWorkflowChangeRequestOrigin(value: unknown): value is WorkflowChangeRequestOrigin {
	return (
		value === "internal-agent" ||
		value === "supervisor" ||
		value === "human" ||
		value === "slash-command" ||
		value === "test" ||
		value === "external-api"
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(entry => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowUsage(): string {
	return [
		"Usage: /workflow inspect",
		"Usage: /workflow list [--family-id <id>]",
		"Usage: /workflow freeze <path> [--family-id <id>]",
		"Usage: /workflow start <path> [--run-id <id>] [--family-id <id>] [--start <node-id>]",
		"Usage: /workflow request-change <file> [--family-id <id>] [--attempt-id <id>]",
		"Usage: /workflow approve-change <change-request-id> [--actor <actor>]",
		"Usage: /workflow reject-change <change-request-id> [--actor <actor>] [--reason <text>]",
		"Usage: /workflow stop <attempt-id> [--deadline-ms <n>]",
		"Usage: /workflow restart <checkpoint-id> [--freeze-id <id>]",
	].join("\n");
}

function formatWorkflowLifecycleList(families: WorkflowRunFamilySnapshot[]): string {
	const attempts = families.flatMap(family => family.attempts);
	const freezes = families.flatMap(family => family.freezes);
	const checkpoints = families.flatMap(family => family.checkpoints);
	const changeRequests = families.flatMap(family => family.changeRequests);
	const lines = [`Workflow families: ${families.length}`];
	for (const family of families) {
		const objective = family.objective ? ` - ${family.objective}` : "";
		lines.push(
			`- ${family.id} freezes=${family.freezes.length} attempts=${family.attempts.length} checkpoints=${family.checkpoints.length} changes=${family.changeRequests.length}${objective}`,
		);
	}
	if (attempts.length > 0) {
		lines.push("Workflow attempts:");
		for (const attempt of attempts) {
			const checkpoint = attempt.checkpointId ? ` from=${attempt.checkpointId}` : "";
			lines.push(
				`- ${attempt.id} ${attempt.status} freeze=${attempt.freezeId}${checkpoint} start=${attempt.startNodeId} activations=${attempt.activations.length} binding=${attempt.runtimeBindingSnapshot.id}`,
			);
		}
	}
	if (freezes.length > 0) {
		lines.push("Workflow freezes:");
		for (const freeze of freezes) {
			lines.push(
				`- ${freeze.id} nodes=${freeze.definition.nodes.length} resources=${freeze.resourceHashes.length} graph=${freeze.canonicalGraphHash}`,
			);
		}
	}
	if (checkpoints.length > 0) {
		lines.push("Workflow checkpoints:");
		for (const checkpoint of checkpoints) {
			lines.push(
				`- ${checkpoint.id} attempt=${checkpoint.attemptId} completed=${checkpoint.completedActivationIds.length} aborted=${checkpoint.abortedActivationIds.length} frontier=${checkpoint.frontierNodeIds.join(", ") || "none"}`,
			);
		}
	}
	if (changeRequests.length > 0) {
		lines.push("Workflow change requests:");
		for (const request of changeRequests) {
			const approval = request.approvedBy ? ` approvedBy=${request.approvedBy}` : "";
			const rejection = request.rejectedBy ? ` rejectedBy=${request.rejectedBy}` : "";
			lines.push(
				`- ${request.id} ${request.status} ${request.origin} actor=${request.actor} ops=${request.operations.length}${approval}${rejection} - ${request.reason}`,
			);
		}
	}
	return lines.join("\n");
}

function formatWorkflowInspection(inspection: WorkflowInspection): string {
	const completed = inspection.activations.filter(activation => activation.status === "completed").length;
	const failed = inspection.activations.filter(activation => activation.status === "failed").length;
	const running = inspection.activations.filter(activation => activation.status === "running").length;
	const lines = [
		`Workflow run: ${inspection.runId}`,
		`Graph: ${inspection.graph.nodes.length} ${plural("node", inspection.graph.nodes.length)}, ${inspection.graph.edges.length} ${plural("edge", inspection.graph.edges.length)}`,
		`Current graph revision: ${inspection.currentGraphRevisionId}`,
		`State keys: ${Object.keys(inspection.state).join(", ") || "none"}`,
		`Activations: ${formatActivationCounts({ completed, failed, running })}`,
	];
	if (inspection.graph.nodes.length > 0) {
		lines.push("Graph nodes:");
		for (const node of inspection.graph.nodes) {
			lines.push(`- ${node.id} (${node.type})`);
		}
	}
	if (inspection.graph.edges.length > 0) {
		lines.push("Graph edges:");
		for (const edge of inspection.graph.edges) {
			lines.push(`- ${edge.from} -> ${edge.to}${formatEdgeCondition(edge.condition)}`);
		}
	}
	if (inspection.pendingGraphPatchProposals.length > 0 || inspection.appliedGraphPatches.length > 0) {
		lines.push(
			`Graph patches: ${inspection.pendingGraphPatchProposals.length} pending, ${inspection.appliedGraphPatches.length} applied`,
		);
	}
	if (inspection.pendingGraphPatchProposals.length > 0) {
		lines.push("Pending graph patch proposals:");
		for (const proposal of inspection.pendingGraphPatchProposals) {
			lines.push(
				`- ${proposal.id} ${proposal.actor}${formatReason(proposal.reason)} (${formatPatchImpact(proposal.impact)})`,
			);
		}
	}
	if (inspection.appliedGraphPatches.length > 0) {
		lines.push("Applied graph patches:");
		for (const patch of inspection.appliedGraphPatches) {
			const proposal = patch.proposalId === undefined ? "" : ` from ${patch.proposalId}`;
			lines.push(
				`- ${patch.graphRevisionId} ${patch.actor}${proposal}${formatReason(patch.reason)} (${formatPatchImpact(patch.impact)})`,
			);
		}
	}
	if (inspection.activations.length > 0) {
		lines.push("Activation details:");
		for (const activation of inspection.activations) {
			const summary = activation.summary ? ` - ${activation.summary}` : "";
			lines.push(`- ${activation.id} ${activation.nodeId} ${activation.status}${summary}`);
		}
	}
	if (inspection.modelAssignments.length > 0) {
		lines.push("Model assignments:");
		for (const assignment of inspection.modelAssignments) {
			const model = assignment.resolvedModel ?? "unresolved";
			lines.push(`- ${assignment.activationId} ${assignment.nodeId} ${model} (${assignment.source})`);
		}
	}
	return lines.join("\n");
}

function formatWorkflowLifecycleInspection(inspection: WorkflowLifecycleInspection): string {
	const lines = [
		`Workflow family: ${inspection.familyId}`,
		`Freezes: ${inspection.freezeIds.join(", ") || "none"}`,
		`Attempts: ${inspection.attempts.length}`,
		`Checkpoints: ${inspection.checkpoints.length}`,
		`Change requests: ${inspection.changeRequests.length}`,
	];
	if (inspection.objective !== undefined) lines.splice(1, 0, `Objective: ${inspection.objective}`);
	if (inspection.attempts.length > 0) {
		lines.push("Attempt lineage:");
		for (const attempt of inspection.attempts) {
			const checkpoint = attempt.checkpointId ? ` from ${attempt.checkpointId}` : "";
			const summary = attempt.summary ? ` - ${attempt.summary}` : "";
			lines.push(`- ${attempt.id} ${attempt.status} freeze=${attempt.freezeId}${checkpoint}${summary}`);
			lines.push(
				`  binding=${attempt.runtimeBindingSnapshot.id} activations=${formatRecordCounts(attempt.activationCounts)}`,
			);
			for (const activation of attempt.activations) {
				const activationSummary = activation.summary ? ` - ${activation.summary}` : "";
				const reason = activation.reason ? ` reason=${activation.reason}` : "";
				lines.push(`  - ${activation.id} ${activation.nodeId} ${activation.status}${activationSummary}${reason}`);
			}
		}
	}
	if (inspection.checkpoints.length > 0) {
		lines.push("Checkpoints:");
		for (const checkpoint of inspection.checkpoints) {
			lines.push(
				`- ${checkpoint.id} attempt=${checkpoint.attemptId} completed=${checkpoint.completedActivationCount} aborted=${checkpoint.abortedActivationCount} frontier=${checkpoint.frontierNodeIds.join(", ") || "none"}`,
			);
		}
	}
	if (inspection.changeRequests.length > 0) {
		lines.push("Change requests:");
		for (const request of inspection.changeRequests) {
			const approval = request.approvedBy ? ` approvedBy=${request.approvedBy}` : "";
			const rejection = request.rejectedBy ? ` rejectedBy=${request.rejectedBy}` : "";
			lines.push(
				`- ${request.id} ${request.status} ${request.origin} actor=${request.actor} ops=${request.operationCount}${approval}${rejection} - ${request.reason}`,
			);
		}
	}
	return lines.join("\n");
}

function formatRecordCounts(counts: Record<string, number>): string {
	const parts = Object.keys(counts)
		.sort()
		.map(key => `${key}:${counts[key]}`);
	return parts.join(" ") || "0";
}

function formatReason(reason: string | undefined): string {
	return reason === undefined ? "" : ` - ${reason}`;
}

function formatEdgeCondition(condition: string | undefined): string {
	return condition === undefined ? "" : ` when ${condition}`;
}

function formatPatchImpact(impact: WorkflowInspection["pendingGraphPatchProposals"][number]["impact"]): string {
	const parts = [
		formatImpactCount(impact.addedNodes, "added node"),
		formatImpactCount(impact.removedNodes, "removed node"),
		formatImpactCount(impact.changedNodes, "changed node"),
		formatImpactCount(impact.addedEdges, "added edge"),
		formatImpactCount(impact.removedEdges, "removed edge"),
		formatImpactCount(impact.changedEdges, "changed edge"),
		formatImpactCount(impact.promptSourceChanges, "prompt source change"),
		formatImpactCount(impact.modelChanges, "model change"),
		formatImpactCount(impact.permissionChanges, "permission change"),
		formatImpactCount(impact.modelRoleChanges, "model role change"),
		formatImpactCount(impact.warnings, "warning"),
	].filter(part => part !== undefined);
	return parts.length > 0 ? parts.join(", ") : "no graph changes";
}

function formatImpactCount(count: number, label: string): string | undefined {
	if (count === 0) return undefined;
	return `${count} ${plural(label, count)}`;
}

function formatActivationCounts(counts: { completed: number; failed: number; running: number }): string {
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed} completed`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.running > 0) parts.push(`${counts.running} running`);
	return parts.length > 0 ? parts.join(", ") : "0";
}

function plural(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}
