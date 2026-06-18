import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { formatModelString } from "../../config/model-resolver";
import { PluginManager } from "../../extensibility/plugins/manager";
import type { SessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { parseCommandArgs } from "../../utils/command-args";
import { workflowAgentTaskIdForNode } from "../../workflow/agent-task-id";
import { resolveWorkflowFlowSpec } from "../../workflow/artifact-registry";
import { parseWorkflowChangeRequestFile } from "../../workflow/change-request-file";
import { evaluateWorkflowCondition } from "../../workflow/condition";
import type {
	WorkflowDefinition,
	WorkflowEdge,
	WorkflowNode,
	WorkflowPromptSource,
	WorkflowScriptSource,
	WorkflowTemplatePromptBindingSource,
} from "../../workflow/definition";
import { type FlowFreeze, freezeWorkflowArtifact } from "../../workflow/freeze";
import {
	buildWorkflowGraphView,
	formatWorkflowChangeReviewLines,
	formatWorkflowConditionLabel,
	formatWorkflowControlLines,
	formatWorkflowOnFlightLines,
	formatWorkflowOverviewLines,
	formatWorkflowRecentActivityLines,
	renderWorkflowGraphText,
	type WorkflowGraphView,
} from "../../workflow/graph-view";
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
	findRunningWorkflowCheckpointResumeAttempt,
	type ProposeWorkflowChangeRequestOptions,
	proposeWorkflowChangeRequest,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	recordWorkflowChangeRequestApplied,
	recordWorkflowFreeze,
	rejectWorkflowChangeRequest,
	requestWorkflowAttemptStop,
	resolveWorkflowRestartStartNodeIds,
	startWorkflowFamily,
	type WorkflowChangeRequestRecord,
	type WorkflowCheckpointSnapshot,
	type WorkflowRunAttemptSnapshot,
	type WorkflowRunFamilySnapshot,
	workflowChangeApplicationError,
	workflowChangeApprovalDenial,
	workflowChangeFreezeApplicationError,
	workflowChangeProposalDenial,
	workflowFreezeForChangeTarget,
} from "../../workflow/lifecycle";
import { resolveWorkflowNodeModel, type WorkflowModelResolutionAudit } from "../../workflow/model-resolution";
import { parseWorkflowMonitorDisplayMode, workflowMonitorDisplayModeLabel } from "../../workflow/monitor-display-mode";
import type { WorkflowNodeRuntimeHost } from "../../workflow/node-runtime";
import { loadWorkflowArtifact, loadWorkflowPackage, type WorkflowArtifact } from "../../workflow/package-loader";
import { applyWorkflowGraphPatch } from "../../workflow/patches";
import { reconstructWorkflowRuns } from "../../workflow/run-store";
import {
	runWorkflow,
	type WorkflowRunnerLifecycleOptions,
	type WorkflowRunnerModelResolutionOptions,
} from "../../workflow/runner";
import { workflowRuntimeBindingUnavailableError } from "../../workflow/runtime-binding";
import { DEFAULT_WORKFLOW_MAX_RUNTIME_MS } from "../../workflow/runtime-timeout";
import type { WorkflowActivation } from "../../workflow/scheduler";
import { applyWorkflowStatePatch } from "../../workflow/state";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { createMarketplaceManager } from "./marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

interface WorkflowStartArgs {
	workflowPath: string;
	runId?: string;
	startNodeId?: string;
	familyId?: string;
	maxActivations?: number;
	maxNodeActivations?: number;
	maxRuntimeMs?: number;
	background?: boolean;
}

interface WorkflowStopArgs {
	attemptId: string;
	deadlineMs?: number;
}

interface WorkflowInterruptArgs {
	attemptId: string;
	target: string;
	deadlineMs?: number;
}

interface WorkflowRestartArgs {
	checkpointId: string;
	freezeId?: string;
	maxRuntimeMs?: number;
	background?: boolean;
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

interface WorkflowApplyChangeArgs {
	changeRequestId: string;
	actor?: string;
	reason?: string;
	freezeId?: string;
	draftId?: string;
	draftPath?: string;
}

interface WorkflowDraftFreezeApplication {
	changeRequestId: string;
	actor: string;
}

interface WorkflowListArgs {
	familyId?: string;
}

type WorkflowManagerArgs = WorkflowListArgs;

interface WorkflowStartPackage {
	rootPath: string;
	workflowPath: string;
	definition: WorkflowDefinition;
	freeze?: FlowFreeze;
}

const WORKFLOW_DETAIL_PREVIEW_CHARS = 180;
const activeWorkflowAttempts = new WeakMap<object, Map<string, ActiveWorkflowAttempt>>();

interface ActiveWorkflowAttempt {
	attemptId: string;
	familyId: string;
	runId: string;
	stopController: AbortController;
	nodeAbortController: AbortController;
	nodeAbortControllers: Map<string, AbortController>;
	lifecycle: WorkflowRunnerLifecycleOptions;
	finished: Promise<void>;
}

interface ResolvedWorkflowAttempt {
	family: WorkflowRunFamilySnapshot;
	attempt: WorkflowRunAttemptSnapshot;
}

export async function handleWorkflowAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "inspect") {
		return handleInspectCommand(runtime);
	}
	if (verb === "help") {
		return handleWorkflowHelpCommand(rest, runtime);
	}
	if (verb === "list") {
		return handleListCommand(rest, runtime);
	}
	if (verb === "graph") {
		return handleGraphCommand(rest, runtime);
	}
	if (verb === "manager") {
		return handleManagerCommand(rest, runtime);
	}
	if (verb === "status") {
		return handleStatusCommand(rest, runtime);
	}
	if (verb === "dashboard") {
		return handleDashboardCommand(rest, runtime);
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
	if (verb === "apply-change") {
		return handleApplyChangeCommand(rest, runtime);
	}
	if (verb === "stop") {
		return handleStopCommand(rest, runtime);
	}
	if (verb === "interrupt") {
		return handleInterruptCommand(rest, runtime);
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

async function handleGraphCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowGraphArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	if (parsed.familyId !== undefined) families = families.filter(family => family.id === parsed.familyId);
	if (families.length === 0) {
		await runtime.output(
			parsed.familyId ? `Workflow family not found: ${parsed.familyId}` : "No workflow families found.",
		);
		return commandConsumed();
	}
	await emitWorkflowGraphViews(
		families.map(family => buildWorkflowGraphViewForRuntime(family, runtime)),
		runtime,
	);
	return commandConsumed();
}

async function handleManagerCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowManagerArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	return outputWorkflowManager(parsed, runtime);
}

async function handleStatusCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const help = parseSubcommand(rest);
	if (help.verb === "help" && help.rest.length === 0) {
		await runtime.output(formatWorkflowStatusHelp());
		return commandConsumed();
	}
	const parsed = parseWorkflowStatusArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	return outputWorkflowManager(parsed, runtime);
}

async function handleDashboardCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseSubcommand(rest);
	if (parsed.verb === "help" && parsed.rest.length === 0) {
		await runtime.output(formatWorkflowDashboardHelp());
		return commandConsumed();
	}
	if (!parsed.verb || parsed.verb === "status") {
		const mode = runtime.getWorkflowGraphMonitorDisplayMode?.();
		await runtime.output(
			mode === undefined
				? "Workflow dashboard display mode is available in the interactive TUI."
				: `Workflow dashboard display mode: ${workflowMonitorDisplayModeLabel(mode)}.`,
		);
		return commandConsumed();
	}
	const mode = parseWorkflowMonitorDisplayMode(parsed.verb);
	if (mode === undefined || parsed.rest.length > 0) {
		return usage(formatWorkflowDashboardHelp(), runtime);
	}
	if (runtime.setWorkflowGraphMonitorDisplayMode === undefined) {
		return usage("Workflow dashboard display mode is only available in the interactive TUI.", runtime);
	}
	await runtime.setWorkflowGraphMonitorDisplayMode(mode);
	await runtime.output(`Workflow dashboard display mode: ${workflowMonitorDisplayModeLabel(mode)}.`);
	return commandConsumed();
}

async function handleWorkflowHelpCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseSubcommand(rest);
	if (!parsed.verb) {
		await runtime.output(formatWorkflowHelp());
		return commandConsumed();
	}
	if (parsed.rest.length > 0) return usage("Usage: /workflow help [topic]", runtime);
	if (parsed.verb === "dashboard") {
		await runtime.output(formatWorkflowDashboardHelp());
		return commandConsumed();
	}
	if (parsed.verb === "status" || parsed.verb === "manager" || parsed.verb === "graph") {
		await runtime.output(formatWorkflowStatusHelp());
		return commandConsumed();
	}
	if (parsed.verb === "agents" || parsed.verb === "agent" || parsed.verb === "nodes" || parsed.verb === "node") {
		await runtime.output(formatWorkflowAgentsHelp());
		return commandConsumed();
	}
	if (
		parsed.verb === "lifecycle" ||
		parsed.verb === "stop" ||
		parsed.verb === "interrupt" ||
		parsed.verb === "restart"
	) {
		await runtime.output(formatWorkflowLifecycleHelp());
		return commandConsumed();
	}
	if (parsed.verb === "change" || parsed.verb === "request-change" || parsed.verb === "apply-change") {
		await runtime.output(formatWorkflowChangeHelp());
		return commandConsumed();
	}
	return usage(formatWorkflowHelp(), runtime);
}

async function outputWorkflowManager(
	args: WorkflowManagerArgs,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	let families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	if (args.familyId !== undefined) families = families.filter(family => family.id === args.familyId);
	if (families.length === 0) {
		await runtime.output(
			args.familyId ? `Workflow family not found: ${args.familyId}` : "No workflow families found.",
		);
		return commandConsumed();
	}
	await runtime.output(families.map(family => formatWorkflowManager(family, runtime)).join("\n\n"));
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
	let pkg: WorkflowStartPackage;
	try {
		const spec = await resolveWorkflowFlowSpec(parsed.workflowPath, { cwd: runtime.cwd });
		pkg = await loadWorkflowStartPackage(spec.path);
	} catch (error) {
		return usage(errorMessage(error), runtime);
	}
	const startNodeIds =
		parsed.startNodeId !== undefined ? [parsed.startNodeId] : defaultWorkflowStartNodeIds(pkg.definition);
	const startNodeId = startNodeIds[0];
	if (!startNodeId) {
		return usage("Workflow start requires a workflow with at least one node.", runtime);
	}
	const runId = parsed.runId ?? `workflow-${Snowflake.next()}`;
	const lifecycleFamilyId = pkg.freeze ? (parsed.familyId ?? `${runId}:family`) : undefined;
	const lifecycleAttemptId = lifecycleFamilyId !== undefined ? `${runId}:attempt-1` : undefined;
	const startConflict = workflowStartConflict(runtime, runId, lifecycleAttemptId);
	if (startConflict !== undefined) return usage(startConflict, runtime);
	const modelResolution = createWorkflowModelResolution(runtime);
	const runtimeHost = await runtime.createWorkflowRuntimeHost();
	const runtimeBindingSnapshot = await createRuntimeBindingSnapshot(
		pkg.definition,
		`${runId}:binding-1`,
		modelResolution,
		runtimeHost,
		runtime,
	);
	const bindingError =
		parsed.maxActivations === 0
			? undefined
			: workflowRuntimeBindingUnavailableError(runtimeBindingSnapshot, pkg.definition, startNodeIds);
	if (bindingError !== undefined) return usage(bindingError, runtime);
	const lifecycle =
		pkg.freeze !== undefined && lifecycleFamilyId !== undefined && lifecycleAttemptId !== undefined
			? ({
					familyId: lifecycleFamilyId,
					attemptId: lifecycleAttemptId,
					freeze: pkg.freeze,
					runtimeBindingSnapshot,
				} satisfies WorkflowRunnerLifecycleOptions)
			: undefined;
	if (parsed.background && lifecycle === undefined) {
		return usage("Workflow background start requires a frozen .omhflow artifact.", runtime);
	}
	const stopController = lifecycle !== undefined ? new AbortController() : undefined;
	const nodeAbortController = lifecycle !== undefined ? new AbortController() : undefined;
	const nodeAbortControllers = new Map<string, AbortController>();
	const runPromise = runWorkflow({
		host: runtime.sessionManager,
		definition: pkg.definition,
		runId,
		startNodeId,
		...(startNodeIds.length > 1 ? { startNodeIds } : {}),
		runtimeHost,
		packageRoot: pkg.rootPath,
		modelResolution,
		...(parsed.maxActivations !== undefined ? { maxActivations: parsed.maxActivations } : {}),
		...(parsed.maxNodeActivations !== undefined ? { maxNodeActivations: parsed.maxNodeActivations } : {}),
		maxRuntimeMs: parsed.maxRuntimeMs ?? DEFAULT_WORKFLOW_MAX_RUNTIME_MS,
		...(stopController !== undefined ? { signal: stopController.signal } : {}),
		...(nodeAbortController !== undefined ? { nodeAbortSignal: nodeAbortController.signal } : {}),
		...(lifecycle !== undefined
			? {
					nodeAbortSignalForActivation: activation =>
						nodeAbortSignalForActivation(nodeAbortControllers, activation),
				}
			: {}),
		lifecycle,
	});
	if (stopController !== undefined && nodeAbortController !== undefined && lifecycle !== undefined) {
		const attemptId = lifecycle.attemptId;
		const failureLabel = parsed.background ? "Workflow background attempt failed" : "Workflow attempt failed";
		const active: ActiveWorkflowAttempt = {
			attemptId,
			familyId: lifecycle.familyId,
			runId,
			stopController,
			nodeAbortController,
			nodeAbortControllers,
			lifecycle,
			finished: runPromise.then(
				() => undefined,
				async error => {
					const message = error instanceof Error ? error.message : String(error);
					await runtime.output(`${failureLabel}: ${attemptId} - ${message}`);
				},
			),
		};
		registerActiveWorkflowAttempt(runtime, active);
		watchWorkflowAttemptCompletion(runtime, active);
		if (parsed.background) {
			await flushWorkflowLifecycle(runtime);
			await runtime.output(`Workflow background attempt started: ${attemptId}`);
			const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
				candidate => candidate.id === lifecycle.familyId,
			);
			if (family) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(family, runtime)], runtime);
			return commandConsumed();
		}
	}
	await runPromise;
	const run = reconstructWorkflowRuns(runtime.sessionManager.getBranch()).find(candidate => candidate.id === runId);
	if (!run) {
		await runtime.output(`Workflow run ${runId} started, but no run records were found.`);
		return commandConsumed();
	}
	const sections = [formatWorkflowInspection(buildWorkflowInspection(run))];
	if (lifecycleFamilyId !== undefined) {
		const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
			candidate => candidate.id === lifecycleFamilyId,
		);
		if (family) {
			if (runtime.outputWorkflowGraph) {
				await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(family, runtime)], runtime);
				await runtime.output(`Workflow monitor active: ${runId} (family ${family.id}).`);
				return commandConsumed();
			}
			await runtime.output(sections.join("\n\n"));
			await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(family, runtime)], runtime);
			return commandConsumed();
		}
	}
	await runtime.output(sections.join("\n\n"));
	return commandConsumed();
}

function workflowStartConflict(
	runtime: SlashCommandRuntime,
	runId: string,
	attemptId: string | undefined,
): string | undefined {
	const existingRun = reconstructWorkflowRuns(runtime.sessionManager.getBranch()).find(run => run.id === runId);
	if (existingRun !== undefined) return `Workflow run already exists: ${runId}`;
	if (attemptId === undefined) return undefined;
	const existingAttempt = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).some(family =>
		family.attempts.some(attempt => attempt.id === attemptId),
	);
	if (existingAttempt) return `Workflow attempt already exists: ${attemptId}`;
	return undefined;
}

async function handleFreezeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowFreezeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let artifact: WorkflowArtifact;
	let freeze: FlowFreeze;
	try {
		const spec = await resolveWorkflowFlowSpec(parsed.workflowPath, { cwd: runtime.cwd });
		artifact = await loadWorkflowArtifact(spec.path);
		freeze = await freezeWorkflowArtifact(artifact);
	} catch (error) {
		return usage(errorMessage(error), runtime);
	}
	const familyId = parsed.familyId ?? `${freeze.id}:family`;
	const existingFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === familyId,
	);
	const draftApplication = workflowDraftFreezeApplication(existingFamily, artifact, freeze);
	if (draftApplication !== undefined && "error" in draftApplication) return usage(draftApplication.error, runtime);
	startWorkflowFamily(runtime.sessionManager, { familyId });
	recordWorkflowFreeze(runtime.sessionManager, freeze, { familyId });
	if (draftApplication !== undefined) {
		recordWorkflowChangeRequestApplied(runtime.sessionManager, {
			changeRequestId: draftApplication.changeRequestId,
			actor: draftApplication.actor,
			target: "freeze",
			freezeId: freeze.id,
		});
	}
	const lines = [`Workflow freeze: ${freeze.id}`, `Family: ${familyId}`];
	if (draftApplication !== undefined) {
		lines.push(`Workflow change request applied: ${draftApplication.changeRequestId} -> freeze ${freeze.id}`);
	}
	await runtime.output(lines.join("\n"));
	const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === familyId,
	);
	if (family) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(family, runtime)], runtime);
	return commandConsumed();
}

function workflowDraftFreezeApplication(
	family: WorkflowRunFamilySnapshot | undefined,
	artifact: WorkflowArtifact,
	freeze: FlowFreeze,
): WorkflowDraftFreezeApplication | { error: string } | undefined {
	if (family === undefined) return undefined;
	const changeRequestId = workflowDraftChangeRequestId(artifact.source);
	if (changeRequestId === undefined) return undefined;
	const request = family.changeRequests.find(candidate => candidate.id === changeRequestId);
	if (request === undefined) return undefined;
	const draftId = path.basename(artifact.flowPath);
	const draftApplication = request.applications.find(
		application => application.target === "draft" && application.draftId === draftId,
	);
	if (draftApplication === undefined) return undefined;
	if (request.status !== "approved") {
		return { error: `Workflow change request is not approved: ${request.id} (${request.status})` };
	}
	if (
		request.applications.some(application => application.target === "freeze" && application.freezeId === freeze.id)
	) {
		return undefined;
	}
	const freezeError = workflowChangeFreezeApplicationError(request, freeze);
	if (freezeError !== undefined) return { error: freezeError };
	return {
		changeRequestId: request.id,
		actor: draftApplication.actor,
	};
}

function workflowDraftChangeRequestId(source: string): string | undefined {
	const match = /^Generated from workflow change request (.+)\.$/m.exec(source);
	const id = match?.[1]?.trim();
	return id ? id : undefined;
}

async function handleRequestChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowRequestChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let request: ProposeWorkflowChangeRequestOptions;
	try {
		request = await readWorkflowChangeRequest(resolveWorkflowPath(parsed.filePath, runtime.cwd), parsed);
	} catch (error) {
		return usage(errorMessage(error), runtime);
	}
	const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === request.familyId,
	);
	if (!family) return usage(`Workflow family not found for change request: ${request.familyId}`, runtime);
	const denial = workflowChangeProposalDenial(family, request);
	if (denial !== undefined) return usage(denial, runtime);
	proposeWorkflowChangeRequest(runtime.sessionManager, request);
	await runtime.output(`Workflow change request: ${request.changeRequestId}\nStatus: proposed`);
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === request.familyId,
	);
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

async function handleApproveChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowApproveChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const actor = parsed.actor ?? "human";
	const family = findWorkflowFamilyByChangeRequest(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		parsed.changeRequestId,
	);
	const request = family?.changeRequests.find(candidate => candidate.id === parsed.changeRequestId);
	if (!family || !request) return usage(`Workflow change request not found: ${parsed.changeRequestId}`, runtime);
	const denial = workflowChangeApprovalDenial(family, request, actor);
	if (denial !== undefined) return usage(denial, runtime);
	approveWorkflowChangeRequest(runtime.sessionManager, {
		changeRequestId: parsed.changeRequestId,
		actor,
		reason: "slash command approval",
	});
	await runtime.output(`Workflow change request approved: ${parsed.changeRequestId}`);
	const updatedFamily = findWorkflowFamilyByChangeRequest(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		parsed.changeRequestId,
	);
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
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
	const family = findWorkflowFamilyByChangeRequest(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		parsed.changeRequestId,
	);
	if (family) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(family, runtime)], runtime);
	return commandConsumed();
}

async function handleApplyChangeCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowApplyChangeArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const family = findWorkflowFamilyByChangeRequest(families, parsed.changeRequestId);
	const request = family?.changeRequests.find(candidate => candidate.id === parsed.changeRequestId);
	if (!family || !request) return usage(`Workflow change request not found: ${parsed.changeRequestId}`, runtime);
	if (request.status !== "approved") {
		return usage(`Workflow change request is not approved: ${request.id} (${request.status})`, runtime);
	}
	const targetFreeze =
		parsed.freezeId === undefined ? undefined : family.freezes.find(freeze => freeze.id === parsed.freezeId);
	if (parsed.freezeId !== undefined && targetFreeze === undefined) {
		return usage(`Workflow freeze not found for change request ${request.id}: ${parsed.freezeId}`, runtime);
	}
	const applicationError = workflowChangeApplicationError(family, request);
	if (applicationError !== undefined) return usage(applicationError, runtime);
	if (targetFreeze !== undefined) {
		const freezeError = workflowChangeFreezeApplicationError(request, targetFreeze);
		if (freezeError !== undefined) return usage(freezeError, runtime);
	}
	let generatedDraftId: string | undefined;
	if (parsed.draftPath !== undefined) {
		const draftBaseFreeze = workflowFreezeForChangeTarget(family, request);
		if (draftBaseFreeze === undefined) {
			return usage(`Workflow freeze not found for change request ${request.id}`, runtime);
		}
		try {
			generatedDraftId = await writeWorkflowChangeDraft(draftBaseFreeze, request, parsed.draftPath);
		} catch (error) {
			return usage(errorMessage(error), runtime);
		}
	}
	const target = parsed.freezeId !== undefined ? "freeze" : "draft";
	const draftId = parsed.draftId ?? generatedDraftId;
	if (!workflowChangeRequestAlreadyApplied(request, target, parsed.freezeId, draftId)) {
		recordWorkflowChangeRequestApplied(runtime.sessionManager, {
			changeRequestId: request.id,
			actor: parsed.actor ?? "human",
			target,
			...(parsed.freezeId !== undefined ? { freezeId: parsed.freezeId } : {}),
			...(draftId !== undefined ? { draftId } : {}),
			...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
		});
	}
	const targetId = parsed.freezeId ?? draftId;
	const updatedFamily = findWorkflowFamilyByChangeRequest(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		request.id,
	);
	await runtime.output(`Workflow change request applied: ${request.id} -> ${target} ${targetId}`);
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

function workflowChangeRequestAlreadyApplied(
	request: WorkflowChangeRequestRecord,
	target: "draft" | "freeze",
	freezeId: string | undefined,
	draftId: string | undefined,
): boolean {
	return request.applications.some(application => {
		if (target === "freeze") {
			return application.target === "freeze" && application.freezeId === freezeId;
		}
		return application.target === "draft" && application.draftId === draftId;
	});
}

async function handleStopCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowStopArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const resolved = resolveWorkflowAttempt(families, parsed.attemptId);
	if (typeof resolved === "string") return usage(resolved, runtime);
	const { family, attempt } = resolved;
	if (attempt.status !== "running") {
		return usage(`Workflow attempt is not running: ${attempt.id} (${attempt.status})`, runtime);
	}
	const active = findActiveWorkflowAttempt(runtime, attempt.id);
	if (active !== undefined) {
		return stopActiveWorkflowAttempt(runtime, family, attempt, active, parsed.deadlineMs ?? 30_000);
	}
	const checkpointId = `${attempt.id}:checkpoint-${family.checkpoints.length + 1}`;
	const runningActivations = attempt.activations.filter(activation => activation.status === "running");
	const runningActivationIds = new Set(runningActivations.map(activation => activation.id));
	const deadlineMs = parsed.deadlineMs ?? 30_000;
	requestWorkflowAttemptStop(runtime.sessionManager, {
		attemptId: attempt.id,
		deadlineMs,
		reason: "slash command stop",
	});
	const settledAttempt = await waitForWorkflowStopDeadline(
		runtime,
		family.id,
		attempt.id,
		runningActivationIds,
		deadlineMs,
	);
	for (const activation of settledAttempt.activations) {
		if (!runningActivationIds.has(activation.id) || activation.status !== "running") continue;
		appendWorkflowAttemptActivationAborted(runtime.sessionManager, {
			attemptId: attempt.id,
			activationId: activation.id,
			nodeId: activation.nodeId,
			reason: "stop deadline elapsed",
		});
	}
	const checkpointFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === family.id,
	);
	const checkpointAttempt =
		checkpointFamily?.attempts.find(candidate => candidate.id === attempt.id) ?? settledAttempt;
	const checkpointFreeze = checkpointFamily?.freezes.find(freeze => freeze.id === checkpointAttempt.freezeId);
	const completedActivationIds = checkpointAttempt.activations
		.filter(activation => activation.status === "completed")
		.map(activation => activation.id);
	const abortedActivationIds = checkpointAttempt.activations
		.filter(activation => activation.status === "aborted")
		.map(activation => activation.id);
	const frontierNodeIds = deriveStopFrontierNodeIds(checkpointAttempt, checkpointFreeze, runningActivationIds);
	const checkpoint = createWorkflowCheckpoint(runtime.sessionManager, {
		checkpointId,
		familyId: checkpointFamily?.id ?? family.id,
		attemptId: attempt.id,
		completedActivationIds,
		abortedActivationIds,
		frontierNodeIds,
		state: deriveLifecycleAttemptState(checkpointAttempt),
		sourceMapping: checkpointSourceMapping(checkpointFamily ?? family, attempt.id, frontierNodeIds),
	});
	await flushWorkflowLifecycle(runtime);
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === family.id,
	);
	const sections = [formatWorkflowCheckpoint(checkpoint)];
	await runtime.output(sections.join("\n\n"));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

async function handleInterruptCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowInterruptArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const resolved = resolveWorkflowAttempt(families, parsed.attemptId);
	if (typeof resolved === "string") return usage(resolved, runtime);
	const { family, attempt } = resolved;
	if (attempt.status !== "running") {
		return usage(`Workflow attempt is not running: ${attempt.id} (${attempt.status})`, runtime);
	}
	const active = findActiveWorkflowAttempt(runtime, attempt.id);
	if (active === undefined) {
		return usage(`Workflow attempt is not attached to this OMP session: ${attempt.id}`, runtime);
	}
	return interruptActiveWorkflowActivation(
		runtime,
		family,
		attempt,
		active,
		parsed.target,
		parsed.deadlineMs ?? 30_000,
	);
}

async function stopActiveWorkflowAttempt(
	runtime: SlashCommandRuntime,
	family: WorkflowRunFamilySnapshot,
	attempt: WorkflowRunAttemptSnapshot,
	active: ActiveWorkflowAttempt,
	deadlineMs: number,
): Promise<SlashCommandResult> {
	active.lifecycle.stopDeadlineMs = deadlineMs;
	requestWorkflowAttemptStop(runtime.sessionManager, {
		attemptId: attempt.id,
		deadlineMs,
		reason: "slash command stop",
	});
	await flushWorkflowLifecycle(runtime);
	if (!active.stopController.signal.aborted) {
		active.stopController.abort("slash command stop");
	}
	if (deadlineMs <= 0) {
		abortActiveWorkflowNodes(active);
		await active.finished;
	} else {
		const finishedBeforeDeadline = await Promise.race([
			active.finished.then(() => true),
			Bun.sleep(deadlineMs).then(() => false),
		]);
		if (!finishedBeforeDeadline) {
			abortActiveWorkflowNodes(active);
			await active.finished;
		}
	}
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === family.id,
	);
	const checkpoint = updatedFamily?.checkpoints.filter(candidate => candidate.attemptId === attempt.id).at(-1);
	if (!checkpoint) {
		return usage(`Workflow active attempt did not create a checkpoint: ${attempt.id}`, runtime);
	}
	await flushWorkflowLifecycle(runtime);
	await runtime.output(formatWorkflowCheckpoint(checkpoint));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

async function interruptActiveWorkflowActivation(
	runtime: SlashCommandRuntime,
	family: WorkflowRunFamilySnapshot,
	attempt: WorkflowRunAttemptSnapshot,
	active: ActiveWorkflowAttempt,
	target: string,
	deadlineMs: number,
): Promise<SlashCommandResult> {
	const activation = resolveInterruptTarget(attempt, target);
	if (activation === undefined) {
		return usage(`Workflow running activation not found: ${target}`, runtime);
	}
	const controller = active.nodeAbortControllers.get(activation.id);
	if (controller === undefined) {
		return usage(`Workflow activation is not attached to this OMP session: ${activation.id}`, runtime);
	}
	active.lifecycle.stopDeadlineMs = deadlineMs;
	if (!active.stopController.signal.aborted) {
		active.stopController.abort(`workflow activation interrupted: ${activation.nodeId}`);
	}
	if (deadlineMs <= 0) {
		abortWorkflowActivation(controller, `workflow activation interrupted: ${activation.nodeId}`);
	} else {
		const finishedBeforeDeadline = await Promise.race([
			active.finished.then(() => true),
			Bun.sleep(deadlineMs).then(() => false),
		]);
		if (!finishedBeforeDeadline) {
			abortWorkflowActivation(controller, `workflow activation interrupted: ${activation.nodeId}`);
		}
	}
	await active.finished;
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === family.id,
	);
	const checkpoint = updatedFamily?.checkpoints.filter(candidate => candidate.attemptId === attempt.id).at(-1);
	if (!checkpoint) {
		return usage(`Workflow active attempt did not create a checkpoint: ${attempt.id}`, runtime);
	}
	await flushWorkflowLifecycle(runtime);
	await runtime.output(`Workflow interrupted activation: ${activation.id} (${activation.nodeId})`);
	await runtime.output(formatWorkflowCheckpoint(checkpoint));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

function abortActiveWorkflowNodes(active: ActiveWorkflowAttempt): void {
	if (!active.nodeAbortController.signal.aborted) {
		active.nodeAbortController.abort("stop deadline elapsed");
	}
	for (const controller of active.nodeAbortControllers.values()) {
		abortWorkflowActivation(controller, "stop deadline elapsed");
	}
}

function abortWorkflowActivation(controller: AbortController, reason: string): void {
	if (!controller.signal.aborted) {
		controller.abort(reason);
	}
}

async function handleRestartCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowRestartArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const located = findCheckpoint(families, parsed.checkpointId);
	if (!located) return usage(await formatWorkflowCheckpointNotFound(parsed.checkpointId, runtime), runtime);
	const runningResume = findRunningWorkflowCheckpointResumeAttempt(located.family, located.checkpoint.id);
	if (runningResume !== undefined) {
		return usage(
			`Workflow checkpoint already has a running resume: ${located.checkpoint.id} (${runningResume.id})`,
			runtime,
		);
	}
	const freeze =
		parsed.freezeId !== undefined
			? located.family.freezes.find(candidate => candidate.id === parsed.freezeId)
			: located.family.freezes.at(-1);
	if (!freeze) return usage(`Workflow freeze not found: ${parsed.freezeId ?? "latest"}`, runtime);
	let startNodeIds: string[];
	try {
		startNodeIds = resolveWorkflowRestartStartNodeIds(located.family, located.checkpoint, freeze);
	} catch (error) {
		return usage(errorMessage(error), runtime);
	}
	if (startNodeIds.length === 0) {
		return usage(`Workflow checkpoint has no restartable frontier: ${parsed.checkpointId}`, runtime);
	}
	const startNodeId = startNodeIds[0]!;
	const attemptId = nextWorkflowRestartAttemptId(located.family);
	if (!runtime.createWorkflowRuntimeHost) {
		return usage("Workflow restart requires a workflow runtime host.", runtime);
	}
	const modelResolution = createWorkflowModelResolution(runtime);
	const runtimeHost = await runtime.createWorkflowRuntimeHost();
	const runtimeBindingSnapshot = await createRuntimeBindingSnapshot(
		freeze.definition,
		`${attemptId}:binding-1`,
		modelResolution,
		runtimeHost,
		runtime,
	);
	const bindingError = workflowRuntimeBindingUnavailableError(runtimeBindingSnapshot, freeze.definition, startNodeIds);
	if (bindingError !== undefined) return usage(bindingError, runtime);
	const stopController = new AbortController();
	const nodeAbortController = new AbortController();
	const nodeAbortControllers = new Map<string, AbortController>();
	const lifecycle: WorkflowRunnerLifecycleOptions = {
		familyId: located.family.id,
		attemptId,
		checkpointId: located.checkpoint.id,
		freeze,
		runtimeBindingSnapshot,
		recordFamily: false,
		recordFreeze: false,
	};
	const runPromise = runWorkflow({
		host: runtime.sessionManager,
		definition: freeze.definition,
		runId: `${attemptId}:run`,
		startNodeId,
		startNodeIds,
		runtimeHost,
		packageRoot: freeze.resourceDir,
		initialState: located.checkpoint.state,
		completedActivations: checkpointCompletedActivations(located.family, located.checkpoint),
		startParentActivationIds: located.checkpoint.completedActivationIds,
		modelResolution,
		maxRuntimeMs: parsed.maxRuntimeMs ?? DEFAULT_WORKFLOW_MAX_RUNTIME_MS,
		signal: stopController.signal,
		nodeAbortSignal: nodeAbortController.signal,
		nodeAbortSignalForActivation: activation => nodeAbortSignalForActivation(nodeAbortControllers, activation),
		lifecycle,
	});
	const startedAttempt = reconstructWorkflowFamilies(runtime.sessionManager.getBranch())
		.find(candidate => candidate.id === located.family.id)
		?.attempts.find(candidate => candidate.id === attemptId);
	if (!startedAttempt) {
		try {
			await runPromise;
		} catch (error) {
			return usage(`Workflow restart attempt failed before start: ${attemptId} - ${errorMessage(error)}`, runtime);
		}
		return usage(`Workflow restart attempt did not start: ${attemptId}`, runtime);
	}
	const active: ActiveWorkflowAttempt = {
		attemptId,
		familyId: located.family.id,
		runId: `${attemptId}:run`,
		stopController,
		nodeAbortController,
		nodeAbortControllers,
		lifecycle,
		finished: runPromise.then(
			() => undefined,
			async error => {
				const message = error instanceof Error ? error.message : String(error);
				await runtime.output(`Workflow restart attempt failed: ${attemptId} - ${message}`);
			},
		),
	};
	registerActiveWorkflowAttempt(runtime, active);
	watchWorkflowAttemptCompletion(runtime, active);
	if (parsed.background) {
		await flushWorkflowLifecycle(runtime);
		await runtime.output(`Workflow background restart attempt started: ${attemptId}`);
		const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
			candidate => candidate.id === located.family.id,
		);
		if (updatedFamily)
			await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
		return commandConsumed();
	}
	await runPromise;
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === located.family.id,
	);
	await flushWorkflowLifecycle(runtime);
	const sections = [`Workflow restart attempt: ${attemptId}`];
	await runtime.output(sections.join("\n\n"));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphViewForRuntime(updatedFamily, runtime)], runtime);
	return commandConsumed();
}

async function flushWorkflowLifecycle(runtime: SlashCommandRuntime): Promise<void> {
	await runtime.sessionManager.ensureOnDisk();
	await runtime.sessionManager.flush();
}

function nextWorkflowRestartAttemptId(family: WorkflowRunFamilySnapshot): string {
	const existing = new Set(family.attempts.map(attempt => attempt.id));
	for (let index = family.attempts.length + 1; ; index += 1) {
		const attemptId = `attempt-${index}`;
		if (!existing.has(attemptId)) return attemptId;
	}
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

function defaultWorkflowStartNodeIds(definition: WorkflowDefinition): string[] {
	const incomingNodeIds = new Set(definition.edges.map(edge => edge.to));
	const roots = definition.nodes.filter(node => !incomingNodeIds.has(node.id)).map(node => node.id);
	const fallback = definition.nodes[0]?.id;
	return roots.length > 0 ? roots : fallback !== undefined ? [fallback] : [];
}

function parseWorkflowStartArgs(rest: string): WorkflowStartArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let workflowPath: string | undefined;
	let runId: string | undefined;
	let startNodeId: string | undefined;
	let familyId: string | undefined;
	let maxActivations: number | undefined;
	let maxNodeActivations: number | undefined;
	let maxRuntimeMs: number | undefined;
	let background = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--background") {
			background = true;
			continue;
		}
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
		if (token === "--max-activations") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsedLimit = parseWorkflowActivationLimit(value, "Workflow max activations");
			if ("error" in parsedLimit) return parsedLimit;
			maxActivations = parsedLimit.value;
			index += 1;
			continue;
		}
		if (token === "--max-node-activations") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsedLimit = parseWorkflowActivationLimit(value, "Workflow max node activations");
			if ("error" in parsedLimit) return parsedLimit;
			maxNodeActivations = parsedLimit.value;
			index += 1;
			continue;
		}
		if (token === "--max-runtime-ms") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsedLimit = parseWorkflowActivationLimit(value, "Workflow max runtime");
			if ("error" in parsedLimit) return parsedLimit;
			maxRuntimeMs = parsedLimit.value;
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
	if (maxActivations !== undefined) args.maxActivations = maxActivations;
	if (maxNodeActivations !== undefined) args.maxNodeActivations = maxNodeActivations;
	if (maxRuntimeMs !== undefined) args.maxRuntimeMs = maxRuntimeMs;
	if (background) args.background = true;
	return args;
}

function parseWorkflowActivationLimit(value: string, label: string): { value: number } | { error: string } {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 0) {
		return { error: `${label} must be a non-negative integer.` };
	}
	return { value: limit };
}

function parseWorkflowListArgs(rest: string): WorkflowListArgs | { error: string } {
	return parseWorkflowFamilySelectorArgs(rest, "list");
}

function parseWorkflowGraphArgs(rest: string): WorkflowListArgs | { error: string } {
	return parseWorkflowFamilySelectorArgs(rest, "graph");
}

function parseWorkflowManagerArgs(rest: string): WorkflowManagerArgs | { error: string } {
	return parseWorkflowFamilySelectorArgs(rest, "manager");
}

function parseWorkflowStatusArgs(rest: string): WorkflowManagerArgs | { error: string } {
	return parseWorkflowFamilySelectorArgs(rest, "status");
}

function parseWorkflowFamilySelectorArgs(
	rest: string,
	commandName: "list" | "graph" | "manager" | "status",
): WorkflowListArgs | { error: string } {
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
		if (token.startsWith("--")) {
			return { error: `Unknown workflow ${commandName} option: ${token}\n${workflowUsage()}` };
		}
		return { error: `Unexpected workflow ${commandName} argument: ${token}\n${workflowUsage()}` };
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

function parseWorkflowApplyChangeArgs(rest: string): WorkflowApplyChangeArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let changeRequestId: string | undefined;
	let actor: string | undefined;
	let reason: string | undefined;
	let freezeId: string | undefined;
	let draftId: string | undefined;
	let draftPath: string | undefined;
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
		if (token === "--freeze-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			freezeId = value;
			index += 1;
			continue;
		}
		if (token === "--draft-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			draftId = value;
			index += 1;
			continue;
		}
		if (token === "--draft-path") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			draftPath = value;
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
			return { error: `Unknown workflow apply-change option: ${token}\n${workflowUsage()}` };
		}
		if (changeRequestId !== undefined) {
			return { error: `Unexpected workflow apply-change argument: ${token}\n${workflowUsage()}` };
		}
		changeRequestId = token;
	}
	if (!changeRequestId) return { error: workflowUsage() };
	const targetCount = [freezeId, draftId, draftPath].filter(value => value !== undefined).length;
	if (targetCount !== 1) {
		return {
			error: `Workflow apply-change requires exactly one of --freeze-id, --draft-id, or --draft-path.\n${workflowUsage()}`,
		};
	}
	const args: WorkflowApplyChangeArgs = { changeRequestId };
	if (actor !== undefined) args.actor = actor;
	if (reason !== undefined) args.reason = reason;
	if (freezeId !== undefined) args.freezeId = freezeId;
	if (draftId !== undefined) args.draftId = draftId;
	if (draftPath !== undefined) args.draftPath = draftPath;
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

function parseWorkflowInterruptArgs(rest: string): WorkflowInterruptArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let attemptId: string | undefined;
	let target: string | undefined;
	let deadlineMs: number | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--deadline-ms") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed < 0)
				return { error: "Workflow interrupt deadline must be a non-negative number." };
			deadlineMs = parsed;
			index += 1;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown workflow interrupt option: ${token}\n${workflowUsage()}` };
		if (attemptId === undefined) {
			attemptId = token;
			continue;
		}
		if (target === undefined) {
			target = token;
			continue;
		}
		return { error: `Unexpected workflow interrupt argument: ${token}\n${workflowUsage()}` };
	}
	if (!attemptId || !target) return { error: workflowUsage() };
	const args: WorkflowInterruptArgs = { attemptId, target };
	if (deadlineMs !== undefined) args.deadlineMs = deadlineMs;
	return args;
}

function parseWorkflowRestartArgs(rest: string): WorkflowRestartArgs | { error: string } {
	const tokens = parseCommandArgs(rest);
	let checkpointId: string | undefined;
	let freezeId: string | undefined;
	let maxRuntimeMs: number | undefined;
	let background = false;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === undefined) continue;
		if (token === "--background") {
			background = true;
			continue;
		}
		if (token === "--freeze-id") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			freezeId = value;
			index += 1;
			continue;
		}
		if (token === "--max-runtime-ms") {
			const value = tokens[index + 1];
			if (!value) return { error: workflowUsage() };
			const parsedLimit = parseWorkflowActivationLimit(value, "Workflow max runtime");
			if ("error" in parsedLimit) return parsedLimit;
			maxRuntimeMs = parsedLimit.value;
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
	if (maxRuntimeMs !== undefined) args.maxRuntimeMs = maxRuntimeMs;
	if (background) args.background = true;
	return args;
}

function resolveWorkflowPath(workflowPath: string, cwd: string): string {
	return path.isAbsolute(workflowPath) ? workflowPath : path.resolve(cwd, workflowPath);
}

function createWorkflowModelResolution(runtime: SlashCommandRuntime): WorkflowRunnerModelResolutionOptions | undefined {
	const sessionModels = runtime.session.getAvailableModels?.() ?? [];
	const registryModels = runtime.session.modelRegistry?.getAvailable?.() ?? [];
	const availableModels =
		sessionModels.length > 0
			? sessionModels
			: registryModels.length > 0
				? registryModels
				: runtime.session.model
					? [runtime.session.model]
					: [];
	if (availableModels.length === 0) return undefined;
	return {
		availableModels,
		settings: runtime.settings,
		modelRegistry: runtime.session.modelRegistry,
		parentActiveModelPattern: runtime.session.model ? formatModelString(runtime.session.model) : undefined,
	};
}

function registerActiveWorkflowAttempt(runtime: SlashCommandRuntime, active: ActiveWorkflowAttempt): void {
	activeWorkflowAttemptMap(runtime).set(active.attemptId, active);
}

function unregisterActiveWorkflowAttempt(runtime: SlashCommandRuntime, attemptId: string): void {
	activeWorkflowAttemptMap(runtime).delete(attemptId);
}

function watchWorkflowAttemptCompletion(runtime: SlashCommandRuntime, active: ActiveWorkflowAttempt): void {
	void active.finished.finally(async () => {
		try {
			await flushWorkflowLifecycle(runtime);
		} catch (error) {
			await runtime.output(`Workflow attempt persistence failed: ${active.attemptId} - ${errorMessage(error)}`);
		} finally {
			unregisterActiveWorkflowAttempt(runtime, active.attemptId);
		}
	});
}

function findActiveWorkflowAttempt(runtime: SlashCommandRuntime, attemptId: string): ActiveWorkflowAttempt | undefined {
	return activeWorkflowAttemptMap(runtime).get(attemptId);
}

function resolveWorkflowAttempt(
	families: WorkflowRunFamilySnapshot[],
	attemptId: string,
): ResolvedWorkflowAttempt | string {
	const exact = findWorkflowAttemptByInput(families, attemptId, "exact");
	if (exact.length === 1) return exact[0]!;
	if (exact.length > 1) return ambiguousWorkflowAttemptMessage(attemptId, exact);
	if (attemptId.includes(":")) return `Workflow attempt not found: ${attemptId}`;
	const suffix = findWorkflowAttemptByInput(families, attemptId, "suffix");
	if (suffix.length === 1) return suffix[0]!;
	if (suffix.length > 1) return ambiguousWorkflowAttemptMessage(attemptId, suffix);
	return `Workflow attempt not found: ${attemptId}`;
}

function findWorkflowAttemptByInput(
	families: WorkflowRunFamilySnapshot[],
	attemptId: string,
	mode: "exact" | "suffix",
): ResolvedWorkflowAttempt[] {
	const matches: ResolvedWorkflowAttempt[] = [];
	for (const family of families) {
		for (const attempt of family.attempts) {
			if (mode === "exact" ? attempt.id === attemptId : attempt.id.endsWith(`:${attemptId}`)) {
				matches.push({ family, attempt });
			}
		}
	}
	return matches;
}

function ambiguousWorkflowAttemptMessage(attemptId: string, matches: ResolvedWorkflowAttempt[]): string {
	return [
		`Workflow attempt id is ambiguous: ${attemptId}`,
		"Use a full attempt id:",
		...matches.map(match => `- ${match.attempt.id}`),
	].join("\n");
}

function nodeAbortSignalForActivation(
	controllers: Map<string, AbortController>,
	activation: WorkflowActivation,
): AbortSignal {
	let controller = controllers.get(activation.id);
	if (controller === undefined) {
		controller = new AbortController();
		controllers.set(activation.id, controller);
	}
	return controller.signal;
}

function resolveInterruptTarget(
	attempt: WorkflowRunAttemptSnapshot,
	target: string,
): WorkflowRunAttemptSnapshot["activations"][number] | undefined {
	const running = attempt.activations.filter(activation => activation.status === "running");
	return running.find(activation => interruptTargetAliases(attempt, activation).includes(target));
}

function interruptTargetAliases(
	attempt: WorkflowRunAttemptSnapshot,
	activation: WorkflowRunAttemptSnapshot["activations"][number],
): string[] {
	const displayNodeId = workflowAgentTaskIdForNode(activation.nodeId);
	const aliases = new Set([activation.id, activation.nodeId, displayNodeId]);
	const generation = runningNodeGeneration(attempt, activation);
	if (generation > 1) {
		aliases.add(`${activation.nodeId}-${generation}`);
		aliases.add(`${displayNodeId}-${generation}`);
	}
	return [...aliases];
}

function runningNodeGeneration(
	attempt: WorkflowRunAttemptSnapshot,
	activation: WorkflowRunAttemptSnapshot["activations"][number],
): number {
	let generation = 0;
	for (const candidate of attempt.activations) {
		if (candidate.nodeId === activation.nodeId) generation += 1;
		if (candidate.id === activation.id) return generation;
	}
	return generation;
}

export function buildWorkflowGraphViewForRuntime(
	family: WorkflowRunFamilySnapshot,
	runtime: Pick<SlashCommandRuntime, "sessionManager" | "getWorkflowAgentProgressById">,
): WorkflowGraphView {
	return buildWorkflowGraphView(family, {
		liveAttemptIds: new Set(activeWorkflowAttemptMap(runtime).keys()),
		activeAgentProgressById: runtime.getWorkflowAgentProgressById?.(),
	});
}

function activeWorkflowAttemptMap(
	runtime: Pick<SlashCommandRuntime, "sessionManager">,
): Map<string, ActiveWorkflowAttempt> {
	const key = runtime.sessionManager as object;
	const existing = activeWorkflowAttempts.get(key);
	if (existing !== undefined) return existing;
	const created = new Map<string, ActiveWorkflowAttempt>();
	activeWorkflowAttempts.set(key, created);
	return created;
}

interface RuntimeCapabilitySnapshot {
	availablePlugins: Set<string>;
	disabledPluginReasons: Map<string, string>;
	availableExtensions: Set<string>;
	availableSkills: Set<string>;
	warnings: string[];
}

interface RuntimeCapabilitySnapshotRequest {
	plugins: boolean;
	extensions: boolean;
	skills: boolean;
}

async function createRuntimeBindingSnapshot(
	definition: WorkflowDefinition,
	id: string,
	modelResolution: WorkflowRunnerModelResolutionOptions | undefined,
	runtimeHost: WorkflowNodeRuntimeHost,
	runtime: SlashCommandRuntime,
): Promise<RuntimeBindingSnapshot> {
	const tools = new Set<string>();
	const agents = new Set<string>();
	const plugins = new Set<string>();
	const extensions = new Set<string>();
	const skills = new Set<string>();
	const modelBindings: Record<string, WorkflowModelResolutionAudit> = {};
	const unavailable: string[] = [];
	const runtimeCapabilities = await createRuntimeCapabilitySnapshot(runtime, {
		plugins: (definition.capabilities?.plugins?.length ?? 0) > 0,
		extensions: (definition.capabilities?.extensions?.length ?? 0) > 0,
		skills: (definition.capabilities?.skills?.length ?? 0) > 0,
	});
	for (const node of definition.nodes) {
		if (node.type === "script") tools.add(runtimeBindingScriptToolForNode(node));
		if (node.type === "human") tools.add("ask");
		if (node.type === "agent" || node.type === "review") tools.add("task");
		if (node.agent) agents.add(node.agent);
		recordRuntimeBindingTool(node, runtimeHost, unavailable);
		recordRuntimeBindingModel(definition, node, modelResolution, modelBindings);
	}
	for (const tool of definition.capabilities?.tools ?? []) {
		tools.add(tool);
		recordRuntimeBindingDeclaredTool(tool, runtimeHost, unavailable);
	}
	for (const agent of definition.capabilities?.agents ?? []) {
		agents.add(agent);
		recordRuntimeBindingDeclaredAgent(agent, runtimeHost, unavailable);
	}
	for (const plugin of definition.capabilities?.plugins ?? []) {
		plugins.add(plugin);
		recordRuntimeBindingDeclaredPlugin(plugin, runtimeCapabilities, unavailable);
	}
	for (const extension of definition.capabilities?.extensions ?? []) {
		extensions.add(extension);
		recordRuntimeBindingDeclaredExtension(extension, runtimeCapabilities, unavailable);
	}
	for (const skill of definition.capabilities?.skills ?? []) {
		skills.add(skill);
		recordRuntimeBindingDeclaredSkill(skill, runtimeCapabilities, unavailable);
	}
	const modelDiagnostics = runtimeBindingModelDiagnostics(modelBindings);
	return {
		id,
		requestedRoles: { ...definition.models.roles },
		resolvedModels: modelDiagnostics.resolvedModels,
		modelBindings,
		tools: [...tools].sort(),
		agents: [...agents].sort(),
		plugins: [...plugins].sort(),
		extensions: [...extensions].sort(),
		skills: [...skills].sort(),
		unavailable: [...unavailable, ...modelDiagnostics.unavailable],
		warnings: [...runtimeCapabilities.warnings, ...modelDiagnostics.warnings],
	};
}

async function createRuntimeCapabilitySnapshot(
	runtime: SlashCommandRuntime,
	request: RuntimeCapabilitySnapshotRequest,
): Promise<RuntimeCapabilitySnapshot> {
	const availablePlugins = new Set<string>();
	const disabledPluginReasons = new Map<string, string>();
	const warnings: string[] = [];
	if (request.plugins) {
		await collectPluginCapabilities(runtime, availablePlugins, disabledPluginReasons, warnings);
	}
	return {
		availablePlugins,
		disabledPluginReasons,
		availableExtensions: request.extensions ? collectExtensionCapabilities(runtime) : new Set(),
		availableSkills: request.skills ? collectSkillCapabilities(runtime) : new Set(),
		warnings,
	};
}

async function collectPluginCapabilities(
	runtime: SlashCommandRuntime,
	availablePlugins: Set<string>,
	disabledPluginReasons: Map<string, string>,
	warnings: string[],
): Promise<void> {
	try {
		for (const plugin of await new PluginManager(runtime.cwd).list()) {
			for (const identifier of pluginCapabilityIdentifiers(plugin.name, plugin.manifest.name)) {
				if (plugin.enabled) {
					availablePlugins.add(identifier);
					disabledPluginReasons.delete(identifier);
				} else if (!availablePlugins.has(identifier)) {
					disabledPluginReasons.set(identifier, "installed plugin is disabled");
				}
			}
		}
	} catch (error) {
		warnings.push(`plugin capabilities could not be inspected: ${formatRuntimeBindingErrorMessage(error)}`);
	}
	try {
		const marketplaceManager = await createMarketplaceManager(runtime);
		for (const plugin of await marketplaceManager.listInstalledPlugins()) {
			if (plugin.shadowedBy !== undefined) continue;
			const enabled = plugin.entries.some(entry => entry.enabled !== false);
			if (enabled) {
				availablePlugins.add(plugin.id);
				disabledPluginReasons.delete(plugin.id);
			} else if (!availablePlugins.has(plugin.id)) {
				disabledPluginReasons.set(plugin.id, "installed marketplace plugin is disabled");
			}
		}
	} catch (error) {
		warnings.push(
			`marketplace plugin capabilities could not be inspected: ${formatRuntimeBindingErrorMessage(error)}`,
		);
	}
}

function pluginCapabilityIdentifiers(name: string, manifestName: string | undefined): string[] {
	if (manifestName === undefined || manifestName === name) return [name];
	return [name, manifestName];
}

function collectExtensionCapabilities(runtime: SlashCommandRuntime): Set<string> {
	const available = new Set<string>();
	for (const extensionPath of runtime.session.extensionRunner?.getExtensionPaths() ?? []) {
		addExtensionIdentifier(available, extensionPath);
	}
	return available;
}

function addExtensionIdentifier(available: Set<string>, extensionPath: string): void {
	const trimmed = extensionPath.trim();
	if (!trimmed) return;
	const normalized = path.normalize(trimmed);
	available.add(trimmed);
	available.add(normalized);
	const base = path.basename(normalized);
	if (!base) return;
	available.add(base);
	const ext = path.extname(base);
	if (ext) available.add(base.slice(0, -ext.length));
}

function collectSkillCapabilities(runtime: SlashCommandRuntime): Set<string> {
	return new Set((runtime.session.skills ?? []).map(skill => skill.name));
}

function recordRuntimeBindingTool(
	node: WorkflowNode,
	runtimeHost: WorkflowNodeRuntimeHost,
	unavailable: string[],
): void {
	if (node.type === "script" && runtimeHost.runScriptNode === undefined) {
		const tool = runtimeBindingScriptToolForNode(node);
		const kind = tool === "bash" ? "shell script" : "script";
		pushUnique(unavailable, `tool:${tool}: workflow runtime host does not support ${kind} nodes`);
	}
	if (node.type === "human" && runtimeHost.runHumanNode === undefined) {
		pushUnique(unavailable, "tool:ask: workflow runtime host does not support human nodes");
	}
	if (node.type === "agent" && runtimeHost.runAgentNode === undefined) {
		pushUnique(unavailable, "tool:task: workflow runtime host does not support agent nodes");
	}
	if (node.type === "review" && runtimeHost.runReviewNode === undefined) {
		pushUnique(unavailable, "tool:task: workflow runtime host does not support review nodes");
	}
}

function recordRuntimeBindingDeclaredTool(
	tool: string,
	runtimeHost: WorkflowNodeRuntimeHost,
	unavailable: string[],
): void {
	if (tool === "eval" || tool === "bash") {
		if (runtimeHost.runScriptNode === undefined) {
			const kind = tool === "bash" ? "shell script" : "script";
			pushUnique(unavailable, `tool:${tool}: workflow runtime host does not support ${kind} nodes`);
		}
		return;
	}
	if (tool === "ask") {
		if (runtimeHost.runHumanNode === undefined) {
			pushUnique(unavailable, "tool:ask: workflow runtime host does not support human nodes");
		}
		return;
	}
	if (tool === "task") {
		if (runtimeHost.runAgentNode === undefined && runtimeHost.runReviewNode === undefined) {
			pushUnique(unavailable, "tool:task: workflow runtime host does not support agent or review nodes");
		}
		return;
	}
	pushUnique(unavailable, `tool:${tool}: workflow runtime host cannot resolve declared tool`);
}

function runtimeBindingScriptToolForNode(node: WorkflowNode): "bash" | "eval" {
	return node.script?.language === "sh" ? "bash" : "eval";
}

function recordRuntimeBindingDeclaredAgent(
	agent: string,
	runtimeHost: WorkflowNodeRuntimeHost,
	unavailable: string[],
): void {
	if (runtimeHost.runAgentNode === undefined) {
		pushUnique(unavailable, `agent:${agent}: workflow runtime host does not support agent nodes`);
	}
}

function recordRuntimeBindingDeclaredPlugin(
	plugin: string,
	runtimeCapabilities: RuntimeCapabilitySnapshot,
	unavailable: string[],
): void {
	if (runtimeCapabilities.availablePlugins.has(plugin)) return;
	const disabledReason = runtimeCapabilities.disabledPluginReasons.get(plugin);
	pushUnique(
		unavailable,
		disabledReason
			? `plugin:${plugin}: ${disabledReason}`
			: `plugin:${plugin}: workflow runtime cannot resolve declared plugin`,
	);
}

function recordRuntimeBindingDeclaredExtension(
	extension: string,
	runtimeCapabilities: RuntimeCapabilitySnapshot,
	unavailable: string[],
): void {
	if (!runtimeCapabilities.availableExtensions.has(extension)) {
		pushUnique(unavailable, `extension:${extension}: active session has no matching extension`);
	}
}

function recordRuntimeBindingDeclaredSkill(
	skill: string,
	runtimeCapabilities: RuntimeCapabilitySnapshot,
	unavailable: string[],
): void {
	if (!runtimeCapabilities.availableSkills.has(skill)) {
		pushUnique(unavailable, `skill:${skill}: active session has no matching skill`);
	}
}

function recordRuntimeBindingModel(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	modelResolution: WorkflowRunnerModelResolutionOptions | undefined,
	modelBindings: Record<string, WorkflowModelResolutionAudit>,
): void {
	if (!workflowNodeRequiresModel(node)) return;
	modelBindings[node.id] = resolveRuntimeBindingModelAudit(definition, node, modelResolution);
}

function resolveRuntimeBindingModelAudit(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	modelResolution: WorkflowRunnerModelResolutionOptions | undefined,
): WorkflowModelResolutionAudit {
	const result = resolveWorkflowNodeModel(definition, node, {
		availableModels: modelResolution?.availableModels ?? [],
		settings: modelResolution?.settings,
		matchPreferences: modelResolution?.matchPreferences,
		modelRegistry: modelResolution?.modelRegistry,
		parentActiveModelPattern: modelResolution?.parentActiveModelPattern,
		agentModel: modelResolution === undefined ? undefined : workflowRuntimeAgentModelPattern(modelResolution, node),
	});
	if (modelResolution !== undefined) return result.audit;
	return {
		...result.audit,
		error: "no available models from oh-my-pi runtime configuration",
	};
}

interface RuntimeBindingModelDiagnostics {
	resolvedModels: Record<string, string>;
	unavailable: string[];
	warnings: string[];
}

function runtimeBindingModelDiagnostics(
	modelBindings: Record<string, WorkflowModelResolutionAudit>,
): RuntimeBindingModelDiagnostics {
	const resolvedModels: Record<string, string> = {};
	const unavailable: string[] = [];
	const warnings: string[] = [];
	for (const [nodeId, audit] of Object.entries(modelBindings)) {
		if (audit.resolvedModel !== undefined) {
			resolvedModels[nodeId] = audit.resolvedModel;
		}
		if (audit.warning !== undefined) {
			warnings.push(`model:${nodeId}: ${audit.warning}`);
		}
		if (audit.fallbackUsed) {
			const reason = audit.fallbackReason === undefined ? "fallback used" : audit.fallbackReason;
			warnings.push(`model:${nodeId}: ${reason}`);
		}
		if (audit.error !== undefined) {
			unavailable.push(`model:${nodeId}: ${audit.error}`);
		}
	}
	return { resolvedModels, unavailable, warnings };
}

function workflowRuntimeAgentModelPattern(
	modelResolution: WorkflowRunnerModelResolutionOptions,
	node: WorkflowNode,
): string | string[] | undefined {
	if (!node.agent) return undefined;
	return modelResolution.agentModels?.[node.agent] ?? modelResolution.agentModels?.[node.id];
}

function workflowNodeRequiresModel(node: WorkflowNode): boolean {
	return node.type === "agent" || node.type === "review" || node.model !== undefined;
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

interface WorkflowCheckpointSessionMatch {
	sessionId: string;
	familyId: string;
	checkpointId: string;
}

async function formatWorkflowCheckpointNotFound(checkpointId: string, runtime: SlashCommandRuntime): Promise<string> {
	const match = await findWorkflowCheckpointInPersistedSessions(checkpointId, runtime);
	if (match === undefined) return `Workflow checkpoint not found: ${checkpointId}`;
	return [
		`Workflow checkpoint not found in current session: ${checkpointId}`,
		`Checkpoint exists in session ${match.sessionId}.`,
		`Resume that session first: omp --resume ${match.sessionId}`,
		`Then run: /workflow restart ${match.checkpointId}`,
		`Family: ${match.familyId}`,
	].join("\n");
}

async function findWorkflowCheckpointInPersistedSessions(
	checkpointId: string,
	runtime: SlashCommandRuntime,
): Promise<WorkflowCheckpointSessionMatch | undefined> {
	const sessionAccess = persistedWorkflowSessionAccess(runtime.sessionManager);
	if (sessionAccess === undefined) return undefined;
	let sessions: SessionInfo[];
	try {
		sessions = await SessionManager.list(runtime.cwd, sessionAccess.sessionDir);
	} catch {
		return undefined;
	}
	for (const session of sessions.slice(0, 128)) {
		if (session.id === sessionAccess.currentSessionId) continue;
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(session.path, sessionAccess.sessionDir);
			const located = findCheckpoint(reconstructWorkflowFamilies(manager.getBranch()), checkpointId);
			if (located !== undefined) {
				return { sessionId: session.id, familyId: located.family.id, checkpointId };
			}
		} catch {
			// Ignore unreadable or stale session files on the diagnostic path.
		} finally {
			await manager?.close();
		}
	}
	return undefined;
}

function persistedWorkflowSessionAccess(
	sessionManager: SlashCommandRuntime["sessionManager"],
): { sessionDir: string; currentSessionId?: string } | undefined {
	const candidate = sessionManager as Partial<Pick<SessionManager, "getSessionDir" | "getSessionId">>;
	if (typeof candidate.getSessionDir !== "function") return undefined;
	const sessionDir = candidate.getSessionDir();
	if (sessionDir.length === 0) return undefined;
	const currentSessionId = typeof candidate.getSessionId === "function" ? candidate.getSessionId() : undefined;
	return currentSessionId === undefined ? { sessionDir } : { sessionDir, currentSessionId };
}

function findWorkflowFamilyByChangeRequest(
	families: WorkflowRunFamilySnapshot[],
	changeRequestId: string,
): WorkflowRunFamilySnapshot | undefined {
	return families.find(family => family.changeRequests.some(request => request.id === changeRequestId));
}

async function writeWorkflowChangeDraft(
	baseFreeze: FlowFreeze,
	request: WorkflowChangeRequestRecord,
	draftPath: string,
): Promise<string> {
	if (path.extname(draftPath) !== ".omhflow") {
		throw new Error("Workflow draft path must use the .omhflow extension");
	}
	const actor = workflowGraphPatchActorForApplication(request);
	const result = applyWorkflowGraphPatch(baseFreeze.definition, request.operations, {
		actor,
		reason: request.reason,
	});
	const draftDefinition: WorkflowDefinition = {
		...result.definition,
		version: baseFreeze.definition.version + 1,
	};
	const draftResourceDir = path.join(path.dirname(draftPath), path.basename(draftPath, ".omhflow"));
	await fs.mkdir(draftResourceDir, { recursive: true });
	await restoreWorkflowDraftResources(draftResourceDir, baseFreeze);
	await Bun.write(draftPath, serializeWorkflowDraft(baseFreeze, draftDefinition, request));
	return path.basename(draftPath);
}

function workflowGraphPatchActorForApplication(request: WorkflowChangeRequestRecord): "human" | "supervisor" {
	if (request.approvedBy !== undefined && isSupervisorWorkflowActor(request.approvedBy)) return "supervisor";
	return "human";
}

async function restoreWorkflowDraftResources(resourceDir: string, freeze: FlowFreeze): Promise<void> {
	for (const snapshot of freeze.resourceSnapshots) {
		const resourcePath = workflowDraftResourcePath(resourceDir, snapshot.path);
		await fs.mkdir(path.dirname(resourcePath), { recursive: true });
		await Bun.write(resourcePath, snapshot.text);
	}
}

function formatRuntimeBindingErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function workflowDraftResourcePath(resourceDir: string, relativePath: string): string {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`Workflow frozen resource path is not portable: ${relativePath}`);
	}
	const root = path.resolve(resourceDir);
	const resolved = path.resolve(root, relativePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Workflow frozen resource path escapes draft resource directory: ${relativePath}`);
	}
	return resolved;
}

function serializeWorkflowDraft(
	baseFreeze: FlowFreeze,
	definition: WorkflowDefinition,
	request: WorkflowChangeRequestRecord,
): string {
	const frontmatter = {
		name: definition.name,
		version: definition.version,
		schema: baseFreeze.schemaVersion,
		checkpoint: {
			stopDeadlineMs: baseFreeze.checkpointPolicy?.stopDeadlineMs ?? 0,
		},
		changePolicy: baseFreeze.changePolicy ?? {
			agentsCanPropose: true,
			humansCanApprove: true,
		},
	};
	return [
		"---",
		YAML.stringify(frontmatter, null, 2).trimEnd(),
		"---",
		"",
		`# ${definition.name}`,
		"",
		`Generated from workflow change request ${request.id}.`,
		"",
		"```yaml workflow",
		YAML.stringify(workflowDefinitionToBlock(definition), null, 2).trimEnd(),
		"```",
		"",
	].join("\n");
}

function workflowDefinitionToBlock(definition: WorkflowDefinition): Record<string, unknown> {
	const block: Record<string, unknown> = {
		nodes: Object.fromEntries(definition.nodes.map(node => [node.id, workflowNodeToBlock(node)])),
		edges: definition.edges.map(workflowEdgeToBlock),
	};
	if (Object.keys(definition.models.roles).length > 0 || Object.keys(definition.models.defaults).length > 0) {
		block.models = definition.models;
	}
	if (definition.stateSchema !== undefined) block.stateSchema = definition.stateSchema;
	if (definition.resources !== undefined) block.resources = definition.resources;
	if (definition.capabilities !== undefined) block.capabilities = definition.capabilities;
	if (definition.migrations !== undefined) block.migrations = definition.migrations;
	return block;
}

function workflowNodeToBlock(node: WorkflowNode): Record<string, unknown> {
	const block: Record<string, unknown> = { type: node.type };
	if (node.agent !== undefined) block.agent = node.agent;
	if (node.model !== undefined) block.model = node.model;
	if (node.promptSource !== undefined) block.prompt = workflowPromptSourceToBlock(node.promptSource);
	else if (node.prompt !== undefined) block.prompt = node.prompt;
	if (node.script !== undefined) block.script = workflowScriptSourceToBlock(node.script);
	if (node.gates !== undefined) block.gates = node.gates;
	if (node.reads !== undefined) block.reads = node.reads;
	if (node.writes !== undefined) block.writes = node.writes;
	if (node.waitFor !== undefined) block.waitFor = node.waitFor;
	return block;
}

function workflowPromptSourceToBlock(source: WorkflowPromptSource): unknown {
	if (source.kind === "inline") return source.text;
	if (source.kind === "file") return { file: source.path };
	if (source.kind === "state") return { state: source.path };
	if (source.kind === "human") return { human: source.path };
	if (source.kind === "output") return { output: workflowOutputPromptSourceToBlock(source) };
	return {
		template: {
			file: source.file,
			bindings: Object.fromEntries(
				Object.entries(source.bindings).map(([name, binding]) => [name, workflowPromptBindingToBlock(binding)]),
			),
		},
	};
}

function workflowPromptBindingToBlock(source: WorkflowTemplatePromptBindingSource): unknown {
	if (source.kind === "inline") return { inline: source.text };
	if (source.kind === "state") return { state: source.path };
	if (source.kind === "human") return { human: source.path };
	return { output: workflowOutputPromptSourceToBlock(source) };
}

function workflowOutputPromptSourceToBlock(source: {
	node: string;
	path: string;
	activation: string;
}): Record<string, string> {
	return { node: source.node, path: source.path, activation: source.activation };
}

function workflowScriptSourceToBlock(source: WorkflowScriptSource): Record<string, unknown> {
	const block: Record<string, unknown> = {};
	if (source.language !== undefined) block.language = source.language;
	if (source.code !== undefined) block.inline = source.code;
	if (source.file !== undefined) block.file = source.file;
	return block;
}

function workflowEdgeToBlock(edge: WorkflowEdge): Record<string, unknown> {
	const block: Record<string, unknown> = { from: edge.from, to: edge.to };
	if (edge.condition !== undefined) block.when = edge.condition.source;
	return block;
}

function isSupervisorWorkflowActor(actor: string): boolean {
	return actor === "supervisor" || actor.startsWith("supervisor:");
}

async function waitForWorkflowStopDeadline(
	runtime: SlashCommandRuntime,
	familyId: string,
	attemptId: string,
	runningActivationIds: Set<string>,
	deadlineMs: number,
): Promise<WorkflowRunAttemptSnapshot> {
	let current = findWorkflowAttempt(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		familyId,
		attemptId,
	);
	if (!current) throw new Error(`Workflow attempt not found: ${attemptId}`);
	if (runningActivationIds.size === 0 || deadlineMs <= 0) return current;
	const deadlineAt = Date.now() + deadlineMs;
	while (Date.now() < deadlineAt) {
		current = findWorkflowAttempt(
			reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
			familyId,
			attemptId,
		);
		if (!current) throw new Error(`Workflow attempt not found: ${attemptId}`);
		if (workflowStopActivationsSettled(current, runningActivationIds)) return current;
		const remainingMs = deadlineAt - Date.now();
		if (remainingMs <= 0) break;
		await Bun.sleep(Math.min(10, remainingMs));
	}
	current = findWorkflowAttempt(reconstructWorkflowFamilies(runtime.sessionManager.getBranch()), familyId, attemptId);
	if (!current) throw new Error(`Workflow attempt not found: ${attemptId}`);
	return current;
}

function findWorkflowAttempt(
	families: WorkflowRunFamilySnapshot[],
	familyId: string,
	attemptId: string,
): WorkflowRunAttemptSnapshot | undefined {
	return families.find(family => family.id === familyId)?.attempts.find(attempt => attempt.id === attemptId);
}

function workflowStopActivationsSettled(
	attempt: WorkflowRunAttemptSnapshot,
	runningActivationIds: Set<string>,
): boolean {
	for (const activationId of runningActivationIds) {
		const activation = attempt.activations.find(candidate => candidate.id === activationId);
		if (!activation || activation.status === "running") return false;
	}
	return true;
}

function deriveStopFrontierNodeIds(
	attempt: WorkflowRunAttemptSnapshot,
	freeze: FlowFreeze | undefined,
	runningActivationIds: Set<string>,
): string[] {
	const state = deriveLifecycleAttemptState(attempt);
	const outputs = deriveLifecycleAttemptOutputs(attempt);
	const frontierNodeIds: string[] = [];
	if (attempt.activations.length === 0 && runningActivationIds.size === 0) {
		for (const nodeId of attempt.startNodeIds ?? [attempt.startNodeId]) pushUnique(frontierNodeIds, nodeId);
		return frontierNodeIds;
	}
	for (const activation of attempt.activations) {
		if (!runningActivationIds.has(activation.id)) continue;
		if (activation.status === "completed" && freeze) {
			for (const nodeId of eligibleSuccessorNodeIds(freeze.definition, activation.nodeId, state, outputs)) {
				pushUnique(frontierNodeIds, nodeId);
			}
			continue;
		}
		if (activation.status === "running" || activation.status === "aborted" || activation.status === "failed") {
			pushUnique(frontierNodeIds, activation.nodeId);
		}
	}
	return frontierNodeIds;
}

function eligibleSuccessorNodeIds(
	definition: WorkflowDefinition,
	nodeId: string,
	state: Record<string, unknown>,
	outputs: Record<string, unknown>,
): string[] {
	const nodeIds: string[] = [];
	for (const edge of definition.edges) {
		if (edge.from !== nodeId) continue;
		if (edge.condition && !evaluateWorkflowCondition(edge.condition.source, { state, outputs })) continue;
		pushUnique(nodeIds, edge.to);
	}
	return nodeIds;
}

function deriveLifecycleAttemptOutputs(attempt: WorkflowRunAttemptSnapshot): Record<string, unknown> {
	const outputs: Record<string, unknown> = {};
	for (const activation of attempt.activations) {
		if (activation.status !== "completed") continue;
		if (activation.output?.data !== undefined) {
			outputs[activation.nodeId] = activation.output.data;
		}
	}
	return outputs;
}

function pushUnique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}

function checkpointCompletedActivations(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
): WorkflowActivation[] {
	const attempt = family.attempts.find(candidate => candidate.id === checkpoint.attemptId);
	if (attempt === undefined) return [];
	const completedIds = new Set(checkpoint.completedActivationIds);
	const activations: WorkflowActivation[] = [];
	for (const activation of attempt.activations) {
		if (!completedIds.has(activation.id) || activation.status !== "completed") continue;
		const completed: WorkflowActivation = {
			id: activation.id,
			nodeId: activation.nodeId,
			graphRevisionId: `${attempt.id}:checkpoint`,
			status: "completed",
			parentActivationIds: activation.parentActivationIds,
		};
		if (activation.output !== undefined) completed.output = activation.output;
		activations.push(completed);
	}
	return activations;
}

function deriveLifecycleAttemptState(attempt: WorkflowRunAttemptSnapshot): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	for (const activation of attempt.activations) {
		if (activation.status !== "completed" || !activation.output?.statePatch) continue;
		applyWorkflowStatePatch(state, activation.output.statePatch);
	}
	return state;
}

function checkpointSourceMapping(
	family: WorkflowRunFamilySnapshot,
	attemptId: string,
	frontierNodeIds: string[],
): Record<string, string> {
	const approvedMappings = family.changeRequests
		.filter(
			request =>
				request.status === "approved" && (request.attemptId === undefined || request.attemptId === attemptId),
		)
		.map(request => request.frontierMapping);
	return Object.fromEntries(
		frontierNodeIds.map(nodeId => [
			nodeId,
			approvedMappings.find(mapping => mapping[nodeId] !== undefined)?.[nodeId] ?? nodeId,
		]),
	);
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

function formatWorkflowHelp(): string {
	return [
		"Workflow help",
		"",
		"Common paths:",
		"- Start: /workflow start <flow-or-path> --background",
		"- Monitor: /workflow status, /workflow graph, /workflow dashboard status",
		"- Screen space: /workflow dashboard collapse, /workflow dashboard compact, /workflow dashboard show",
		"- Lifecycle: /workflow stop <attempt-id>, /workflow interrupt <attempt-id> <activation-or-node-id>, /workflow restart <checkpoint-id>",
		"- Change flow: /workflow request-change <file>, /workflow approve-change <id>, /workflow apply-change <id> --freeze-id <id>",
		"",
		"More help:",
		"- /workflow dashboard help",
		"- /workflow status help",
		"- /workflow help agents",
		"- /workflow help lifecycle",
		"- /workflow help change",
	].join("\n");
}

function formatWorkflowDashboardHelp(): string {
	return [
		"Workflow dashboard help",
		"",
		"Display modes:",
		"- /workflow dashboard collapse: keep only resident status, help, restore, and the primary action",
		"- /workflow dashboard compact: keep a short monitor panel",
		"- /workflow dashboard show: restore the full dashboard",
		"- /workflow dashboard status: print the current display mode",
		"",
		"Visible guide path:",
		"- Collapsed and compact dashboards keep /workflow help visible.",
		"- Use /workflow help agents to inspect agents, steer live agents, or interrupt focused program nodes.",
		"- Use /workflow status help for inspection commands.",
	].join("\n");
}

function formatWorkflowStatusHelp(): string {
	return [
		"Workflow status help",
		"",
		"Inspection:",
		"- /workflow status [--family-id <id>]: operator-focused state and next actions",
		"- /workflow manager [--family-id <id>]: lifecycle records, freezes, checkpoints, and changes",
		"- /workflow graph [--family-id <id>]: render the current workflow graph",
		"- /workflow list [--family-id <id>]: list workflow families",
		"",
		"Next step:",
		"- Use /workflow dashboard help to tune the resident TUI monitor.",
	].join("\n");
}

function formatWorkflowAgentsHelp(): string {
	return [
		"Workflow agents and nodes help",
		"",
		"Live agent nodes:",
		"- Press double-left or use observe to open Agent Hub.",
		"- In Agent Hub, select a live workflow agent, press Enter to steer it, and Esc to return.",
		"- Interrupt one live node with /workflow interrupt <attempt-id> <activation-or-node-id>.",
		"",
		"Program, verifier, and checkpointed nodes:",
		"- Use /workflow status to see the focused node and next operator action.",
		"- Use /workflow manager --family-id <id> for lifecycle records, checkpoints, and recent node outputs.",
		"- Interrupt a running non-agent node with /workflow interrupt <attempt-id> <node-id>.",
		"- Use /workflow graph --family-id <id> to redraw the flow map when the resident dashboard is collapsed.",
	].join("\n");
}

function formatWorkflowLifecycleHelp(): string {
	return [
		"Workflow lifecycle help",
		"",
		"Controls:",
		"- /workflow stop <attempt-id> [--deadline-ms <n>]: stop new node triggers, checkpoint, then abort after the deadline",
		"- /workflow interrupt <attempt-id> <activation-or-node-id> [--deadline-ms <n>]: interrupt one active node",
		"- /workflow restart <checkpoint-id> [--freeze-id <id>] [--background]: resume from a checkpoint",
		"",
		"Safe mutation path:",
		"- Stop, checkpoint, change the flow, then restart from the checkpoint.",
	].join("\n");
}

function formatWorkflowChangeHelp(): string {
	return [
		"Workflow change help",
		"",
		"Mutation flow:",
		"- /workflow request-change <file> [--family-id <id>] [--attempt-id <id>]",
		"- /workflow approve-change <change-request-id> [--actor <actor>]",
		"- /workflow reject-change <change-request-id> [--actor <actor>] [--reason <text>]",
		"- /workflow apply-change <change-request-id> (--freeze-id <id>|--draft-id <id>|--draft-path <path>)",
		"",
		"Contract:",
		"- Active-run graph patching is not the interface; use the standard stop, save, change, restart path.",
	].join("\n");
}

function workflowUsage(): string {
	return [
		"Usage: /workflow help [dashboard|status|agents|lifecycle|change]",
		"Usage: /workflow inspect",
		"Usage: /workflow list [--family-id <id>]",
		"Usage: /workflow graph [--family-id <id>]",
		"Usage: /workflow manager [--family-id <id>]",
		"Usage: /workflow status [--family-id <id>]",
		"Usage: /workflow dashboard show|full|compact|collapse|status|help",
		"Usage: /workflow freeze <flow-or-path> [--family-id <id>]",
		"Usage: /workflow start <flow-or-path> [--run-id <id>] [--family-id <id>] [--start <node-id>] [--max-activations <n>] [--max-node-activations <n>] [--max-runtime-ms <n>] [--background]",
		"Usage: /workflow request-change <file> [--family-id <id>] [--attempt-id <id>]",
		"Usage: /workflow approve-change <change-request-id> [--actor <actor>]",
		"Usage: /workflow reject-change <change-request-id> [--actor <actor>] [--reason <text>]",
		"Usage: /workflow apply-change <change-request-id> (--freeze-id <id>|--draft-id <id>|--draft-path <path>) [--actor <actor>] [--reason <text>]",
		"Usage: /workflow stop <attempt-id> [--deadline-ms <n>]",
		"Usage: /workflow interrupt <attempt-id> <activation-or-node-id> [--deadline-ms <n>]",
		"Usage: /workflow restart <checkpoint-id> [--freeze-id <id>] [--max-runtime-ms <n>] [--background]",
	].join("\n");
}

async function emitWorkflowGraphViews(views: WorkflowGraphView[], runtime: SlashCommandRuntime): Promise<void> {
	if (runtime.outputWorkflowGraph) {
		for (const view of views) {
			await runtime.outputWorkflowGraph(view);
		}
		return;
	}
	await runtime.output(views.map(view => renderWorkflowGraphText(view)).join("\n\n"));
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
				`- ${attempt.id} ${attempt.status} freeze=${attempt.freezeId}${checkpoint} start=${formatAttemptStartNodes(attempt)} activations=${attempt.activations.length} binding=${attempt.runtimeBindingSnapshot.id}${formatWorkflowDetail(attempt.summary, attempt.error)}`,
			);
			for (const activation of attempt.activations) {
				if (!activation.error && !activation.reason) continue;
				lines.push(
					`  - ${activation.id} ${activation.nodeId} ${activation.status}${formatWorkflowDetail(activation.output?.summary, activation.error, activation.reason)}`,
				);
			}
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
			const applied =
				request.applications.length > 0 ? ` applied=${formatWorkflowChangeApplications(request.applications)}` : "";
			lines.push(
				`- ${request.id} ${request.status} ${request.origin} actor=${request.actor} ops=${request.operations.length}${approval}${rejection}${applied} - ${request.reason}`,
			);
		}
	}
	return lines.join("\n");
}

function formatWorkflowManager(
	family: WorkflowRunFamilySnapshot,
	runtime: Pick<SlashCommandRuntime, "sessionManager">,
): string {
	const lines = [`Workflow manager: ${family.id}`];
	if (family.objective !== undefined) lines.push(`Objective: ${family.objective}`);
	const graphView = buildWorkflowGraphViewForRuntime(family, runtime);

	lines.push("Overview:");
	for (const line of formatWorkflowOverviewLines(graphView)) lines.push(`- ${line}`);

	const onFlight = formatWorkflowOnFlightLines(graphView);
	if (onFlight.length > 0) {
		lines.push("On-flight:");
		for (const line of onFlight) lines.push(`- ${line}`);
	}

	const recentActivity = formatWorkflowRecentActivityLines(graphView);
	if (recentActivity.length > 0) {
		lines.push("Recent activity:");
		for (const line of recentActivity) lines.push(`- ${line}`);
	}

	lines.push("Change review:");
	const changeReview = formatWorkflowChangeReviewLines(graphView);
	if (changeReview.length === 0) {
		lines.push("- none");
	} else {
		for (const line of changeReview) lines.push(`- ${line}`);
	}

	const diagnostics = formatWorkflowManagerDiagnostics(family);
	if (diagnostics.length > 0) {
		lines.push("Diagnostics:");
		for (const diagnostic of diagnostics) lines.push(`- ${diagnostic}`);
	}

	lines.push("Controls:");
	for (const action of formatWorkflowControlLines(graphView)) lines.push(`- ${action}`);
	return lines.join("\n");
}

function formatWorkflowManagerDiagnostics(family: WorkflowRunFamilySnapshot): string[] {
	const diagnostics: string[] = [];
	for (const attempt of family.attempts) {
		for (const warning of attempt.runtimeBindingSnapshot.warnings) {
			diagnostics.push(`${attempt.id}: warning ${warning}`);
		}
		for (const unavailable of attempt.runtimeBindingSnapshot.unavailable) {
			diagnostics.push(`${attempt.id}: unavailable ${unavailable}`);
		}
	}
	return diagnostics;
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
			lines.push(`- ${edge.from} → ${edge.to}${formatEdgeCondition(edge.condition)}`);
		}
	}
	if (inspection.activations.length > 0) {
		lines.push("Activation details:");
		for (const activation of inspection.activations) {
			lines.push(
				`- ${activation.id} ${activation.nodeId} ${activation.status}${formatWorkflowDetail(activation.summary, activation.error)}`,
			);
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
			lines.push(
				`- ${attempt.id} ${attempt.status} freeze=${attempt.freezeId}${checkpoint} start=${formatAttemptStartNodes(attempt)}${formatWorkflowDetail(attempt.summary, attempt.error)}`,
			);
			lines.push(
				`  binding=${attempt.runtimeBindingSnapshot.id} activations=${formatRecordCounts(attempt.activationCounts)}`,
			);
			for (const activation of attempt.activations) {
				lines.push(
					`  - ${activation.id} ${activation.nodeId} ${activation.status}${formatWorkflowDetail(activation.summary, activation.error, activation.reason)}`,
				);
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
			const applied =
				request.applications.length > 0 ? ` applied=${formatWorkflowChangeApplications(request.applications)}` : "";
			lines.push(
				`- ${request.id} ${request.status} ${request.origin} actor=${request.actor} ops=${request.operationCount}${approval}${rejection}${applied} - ${request.reason}`,
			);
		}
	}
	return lines.join("\n");
}

function formatAttemptStartNodes(attempt: { startNodeId: string; startNodeIds?: string[] }): string {
	return attempt.startNodeIds?.join(",") || attempt.startNodeId;
}

function formatWorkflowChangeApplications(
	applications: Array<{ target: string; actor: string; freezeId?: string; draftId?: string }>,
): string {
	return applications
		.map(application => {
			const targetId = application.freezeId ?? application.draftId;
			return targetId === undefined
				? `${application.target}:${application.actor}`
				: `${application.target}:${targetId}:${application.actor}`;
		})
		.join(",");
}

function formatRecordCounts(counts: Record<string, number>): string {
	const parts = Object.keys(counts)
		.sort()
		.map(key => `${key}:${counts[key]}`);
	return parts.join(" ") || "0";
}

function formatWorkflowDetail(summary?: string, error?: string, reason?: string): string {
	const parts: string[] = [];
	if (summary) parts.push(formatSingleLineWorkflowDetail(summary));
	if (error) parts.push(`error: ${formatSingleLineWorkflowDetail(error)}`);
	if (reason) parts.push(`reason: ${formatSingleLineWorkflowDetail(reason)}`);
	return parts.length === 0 ? "" : ` - ${parts.join("; ")}`;
}

function formatSingleLineWorkflowDetail(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= WORKFLOW_DETAIL_PREVIEW_CHARS) return compact;
	return `${compact.slice(0, WORKFLOW_DETAIL_PREVIEW_CHARS - 3)}...`;
}

function formatEdgeCondition(condition: string | undefined): string {
	return condition === undefined ? "" : ` when ${formatWorkflowConditionLabel(condition)}`;
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
