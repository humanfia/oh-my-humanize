import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { formatModelString } from "../../config/model-resolver";
import { parseCommandArgs } from "../../utils/command-args";
import { evaluateWorkflowCondition } from "../../workflow/condition";
import type {
	WorkflowDefinition,
	WorkflowEdge,
	WorkflowModelContext,
	WorkflowModelUnavailablePolicy,
	WorkflowNode,
	WorkflowNodeType,
	WorkflowPromptActivationSelector,
	WorkflowPromptSource,
	WorkflowScriptLanguage,
	WorkflowScriptSource,
	WorkflowTemplatePromptBindingSource,
} from "../../workflow/definition";
import { type FlowFreeze, freezeWorkflowArtifact, type WorkflowChangePolicy } from "../../workflow/freeze";
import { buildWorkflowGraphView, renderWorkflowGraphText, type WorkflowGraphView } from "../../workflow/graph-view";
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
	recordWorkflowChangeRequestApplied,
	recordWorkflowFreeze,
	rejectWorkflowChangeRequest,
	requestWorkflowAttemptStop,
	startWorkflowFamily,
	type WorkflowChangeRequestOrigin,
	type WorkflowChangeRequestRecord,
	type WorkflowCheckpointSnapshot,
	type WorkflowRunAttemptSnapshot,
	type WorkflowRunFamilySnapshot,
} from "../../workflow/lifecycle";
import { resolveWorkflowNodeModel } from "../../workflow/model-resolution";
import type { WorkflowNodeRuntimeHost } from "../../workflow/node-runtime";
import { loadWorkflowArtifact, loadWorkflowPackage } from "../../workflow/package-loader";
import { applyWorkflowGraphPatch, type WorkflowGraphPatchOperation } from "../../workflow/patches";
import { reconstructWorkflowRuns } from "../../workflow/run-store";
import {
	runWorkflow,
	type WorkflowRunnerLifecycleOptions,
	type WorkflowRunnerModelResolutionOptions,
} from "../../workflow/runner";
import type { WorkflowActivation } from "../../workflow/scheduler";
import { applyWorkflowStatePatch } from "../../workflow/state";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

interface WorkflowStartArgs {
	workflowPath: string;
	runId?: string;
	startNodeId?: string;
	familyId?: string;
	maxActivations?: number;
	maxNodeActivations?: number;
	background?: boolean;
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

interface WorkflowApplyChangeArgs {
	changeRequestId: string;
	actor?: string;
	reason?: string;
	freezeId?: string;
	draftId?: string;
	draftPath?: string;
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
	lifecycle: WorkflowRunnerLifecycleOptions;
	finished: Promise<void>;
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
	if (verb === "graph") {
		return handleGraphCommand(rest, runtime);
	}
	if (verb === "manager") {
		return handleManagerCommand(rest, runtime);
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
	await emitWorkflowGraphViews(families.map(buildWorkflowGraphView), runtime);
	return commandConsumed();
}

async function handleManagerCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowManagerArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	let families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	if (parsed.familyId !== undefined) families = families.filter(family => family.id === parsed.familyId);
	if (families.length === 0) {
		await runtime.output(
			parsed.familyId ? `Workflow family not found: ${parsed.familyId}` : "No workflow families found.",
		);
		return commandConsumed();
	}
	await runtime.output(families.map(formatWorkflowManager).join("\n\n"));
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
	const lifecycle =
		pkg.freeze !== undefined && lifecycleFamilyId !== undefined && lifecycleAttemptId !== undefined
			? ({
					familyId: lifecycleFamilyId,
					attemptId: lifecycleAttemptId,
					freeze: pkg.freeze,
					runtimeBindingSnapshot: createRuntimeBindingSnapshot(
						pkg.definition,
						`${runId}:binding-1`,
						modelResolution,
						runtimeHost,
					),
				} satisfies WorkflowRunnerLifecycleOptions)
			: undefined;
	if (parsed.background && lifecycle === undefined) {
		return usage("Workflow background start requires a frozen .omhflow artifact.", runtime);
	}
	const stopController = lifecycle !== undefined ? new AbortController() : undefined;
	const nodeAbortController = lifecycle !== undefined ? new AbortController() : undefined;
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
		...(stopController !== undefined ? { signal: stopController.signal } : {}),
		...(nodeAbortController !== undefined ? { nodeAbortSignal: nodeAbortController.signal } : {}),
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
		void active.finished.finally(() => unregisterActiveWorkflowAttempt(runtime, attemptId));
		if (parsed.background) {
			await runtime.output(`Workflow background attempt started: ${attemptId}`);
			const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
				candidate => candidate.id === lifecycle.familyId,
			);
			if (family) await emitWorkflowGraphViews([buildWorkflowGraphView(family)], runtime);
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
			await runtime.output(sections.join("\n\n"));
			await emitWorkflowGraphViews([buildWorkflowGraphView(family)], runtime);
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
	const artifact = await loadWorkflowArtifact(resolveWorkflowPath(parsed.workflowPath, runtime.cwd));
	const freeze = await freezeWorkflowArtifact(artifact);
	const familyId = parsed.familyId ?? `${freeze.id}:family`;
	startWorkflowFamily(runtime.sessionManager, { familyId });
	recordWorkflowFreeze(runtime.sessionManager, freeze, { familyId });
	await runtime.output(`Workflow freeze: ${freeze.id}\nFamily: ${familyId}`);
	const family = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === familyId,
	);
	if (family) await emitWorkflowGraphViews([buildWorkflowGraphView(family)], runtime);
	return commandConsumed();
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
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
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
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
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
	if (family) await emitWorkflowGraphViews([buildWorkflowGraphView(family)], runtime);
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
	recordWorkflowChangeRequestApplied(runtime.sessionManager, {
		changeRequestId: request.id,
		actor: parsed.actor ?? "human",
		target,
		...(parsed.freezeId !== undefined ? { freezeId: parsed.freezeId } : {}),
		...(draftId !== undefined ? { draftId } : {}),
		...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
	});
	const targetId = parsed.freezeId ?? draftId;
	const updatedFamily = findWorkflowFamilyByChangeRequest(
		reconstructWorkflowFamilies(runtime.sessionManager.getBranch()),
		request.id,
	);
	await runtime.output(`Workflow change request applied: ${request.id} -> ${target} ${targetId}`);
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
	return commandConsumed();
}

async function handleStopCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const parsed = parseWorkflowStopArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const families = reconstructWorkflowFamilies(runtime.sessionManager.getBranch());
	const family = families.find(candidate => candidate.attempts.some(attempt => attempt.id === parsed.attemptId));
	const attempt = family?.attempts.find(candidate => candidate.id === parsed.attemptId);
	if (!family || !attempt) return usage(`Workflow attempt not found: ${parsed.attemptId}`, runtime);
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
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === family.id,
	);
	const sections = [formatWorkflowCheckpoint(checkpoint)];
	await runtime.output(sections.join("\n\n"));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
	return commandConsumed();
}

async function stopActiveWorkflowAttempt(
	runtime: SlashCommandRuntime,
	family: WorkflowRunFamilySnapshot,
	attempt: WorkflowRunAttemptSnapshot,
	active: ActiveWorkflowAttempt,
	deadlineMs: number,
): Promise<SlashCommandResult> {
	active.lifecycle.stopDeadlineMs = deadlineMs;
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
	await runtime.output(formatWorkflowCheckpoint(checkpoint));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
	return commandConsumed();
}

function abortActiveWorkflowNodes(active: ActiveWorkflowAttempt): void {
	if (!active.nodeAbortController.signal.aborted) {
		active.nodeAbortController.abort("stop deadline elapsed");
	}
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
	const startNodeIds = resolveRestartStartNodeIds(located.checkpoint, freeze, located.family);
	if (startNodeIds.length === 0) {
		return usage(`Workflow checkpoint has no restartable frontier: ${parsed.checkpointId}`, runtime);
	}
	const startNodeId = startNodeIds[0]!;
	const attemptId = `attempt-${located.family.attempts.length + 1}`;
	if (!runtime.createWorkflowRuntimeHost) {
		return usage("Workflow restart requires a workflow runtime host.", runtime);
	}
	const modelResolution = createWorkflowModelResolution(runtime);
	const runtimeHost = await runtime.createWorkflowRuntimeHost();
	const stopController = new AbortController();
	const nodeAbortController = new AbortController();
	const lifecycle: WorkflowRunnerLifecycleOptions = {
		familyId: located.family.id,
		attemptId,
		checkpointId: located.checkpoint.id,
		freeze,
		runtimeBindingSnapshot: createRuntimeBindingSnapshot(
			freeze.definition,
			`${attemptId}:binding-1`,
			modelResolution,
			runtimeHost,
		),
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
		signal: stopController.signal,
		nodeAbortSignal: nodeAbortController.signal,
		lifecycle,
	});
	const active: ActiveWorkflowAttempt = {
		attemptId,
		familyId: located.family.id,
		runId: `${attemptId}:run`,
		stopController,
		nodeAbortController,
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
	void active.finished.finally(() => unregisterActiveWorkflowAttempt(runtime, attemptId));
	await runPromise;
	const updatedFamily = reconstructWorkflowFamilies(runtime.sessionManager.getBranch()).find(
		candidate => candidate.id === located.family.id,
	);
	const sections = [`Workflow restart attempt: ${attemptId}`];
	await runtime.output(sections.join("\n\n"));
	if (updatedFamily) await emitWorkflowGraphViews([buildWorkflowGraphView(updatedFamily)], runtime);
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

function parseWorkflowFamilySelectorArgs(
	rest: string,
	commandName: "list" | "graph" | "manager",
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

function findActiveWorkflowAttempt(runtime: SlashCommandRuntime, attemptId: string): ActiveWorkflowAttempt | undefined {
	return activeWorkflowAttemptMap(runtime).get(attemptId);
}

function activeWorkflowAttemptMap(runtime: SlashCommandRuntime): Map<string, ActiveWorkflowAttempt> {
	const key = runtime.sessionManager as object;
	const existing = activeWorkflowAttempts.get(key);
	if (existing !== undefined) return existing;
	const created = new Map<string, ActiveWorkflowAttempt>();
	activeWorkflowAttempts.set(key, created);
	return created;
}

function createRuntimeBindingSnapshot(
	definition: WorkflowDefinition,
	id: string,
	modelResolution: WorkflowRunnerModelResolutionOptions | undefined,
	runtimeHost: WorkflowNodeRuntimeHost,
): RuntimeBindingSnapshot {
	const tools = new Set<string>();
	const agents = new Set<string>();
	const resolvedModels: Record<string, string> = {};
	const unavailable: string[] = [];
	const warnings: string[] = [];
	for (const node of definition.nodes) {
		if (node.type === "script") tools.add("eval");
		if (node.type === "human") tools.add("ask");
		if (node.type === "agent" || node.type === "review") tools.add("task");
		if (node.agent) agents.add(node.agent);
		recordRuntimeBindingTool(node, runtimeHost, unavailable);
		recordRuntimeBindingModel(definition, node, modelResolution, resolvedModels, unavailable, warnings);
	}
	for (const tool of definition.capabilities?.tools ?? []) {
		tools.add(tool);
		recordRuntimeBindingDeclaredTool(tool, runtimeHost, unavailable);
	}
	for (const agent of definition.capabilities?.agents ?? []) {
		agents.add(agent);
		recordRuntimeBindingDeclaredAgent(agent, runtimeHost, unavailable);
	}
	return {
		id,
		requestedRoles: { ...definition.models.roles },
		resolvedModels,
		tools: [...tools].sort(),
		agents: [...agents].sort(),
		unavailable,
		warnings,
	};
}

function recordRuntimeBindingTool(
	node: WorkflowNode,
	runtimeHost: WorkflowNodeRuntimeHost,
	unavailable: string[],
): void {
	if (node.type === "script" && runtimeHost.runScriptNode === undefined) {
		pushUnique(unavailable, "tool:eval: workflow runtime host does not support script nodes");
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
	if (tool === "eval") {
		if (runtimeHost.runScriptNode === undefined) {
			pushUnique(unavailable, "tool:eval: workflow runtime host does not support script nodes");
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

function recordRuntimeBindingDeclaredAgent(
	agent: string,
	runtimeHost: WorkflowNodeRuntimeHost,
	unavailable: string[],
): void {
	if (runtimeHost.runAgentNode === undefined) {
		pushUnique(unavailable, `agent:${agent}: workflow runtime host does not support agent nodes`);
	}
}

function recordRuntimeBindingModel(
	definition: WorkflowDefinition,
	node: WorkflowNode,
	modelResolution: WorkflowRunnerModelResolutionOptions | undefined,
	resolvedModels: Record<string, string>,
	unavailable: string[],
	warnings: string[],
): void {
	if (!workflowNodeRequiresModel(node)) return;
	if (!modelResolution) {
		unavailable.push(`model:${node.id}: no available models from oh-my-pi runtime configuration`);
		return;
	}
	const result = resolveWorkflowNodeModel(definition, node, {
		availableModels: modelResolution.availableModels,
		settings: modelResolution.settings,
		matchPreferences: modelResolution.matchPreferences,
		modelRegistry: modelResolution.modelRegistry,
		parentActiveModelPattern: modelResolution.parentActiveModelPattern,
		agentModel: workflowRuntimeAgentModelPattern(modelResolution, node),
	});
	const audit = result.audit;
	if (audit.resolvedModel !== undefined) {
		resolvedModels[node.id] = audit.resolvedModel;
	}
	if (audit.warning !== undefined) {
		warnings.push(`model:${node.id}: ${audit.warning}`);
	}
	if (audit.fallbackUsed) {
		const reason = audit.fallbackReason === undefined ? "fallback used" : audit.fallbackReason;
		warnings.push(`model:${node.id}: ${reason}`);
	}
	if (audit.error !== undefined) {
		unavailable.push(`model:${node.id}: ${audit.error}`);
		return;
	}
	if (audit.source === "none" && modelResolution.parentActiveModelPattern !== undefined) {
		resolvedModels[node.id] = modelResolution.parentActiveModelPattern;
		warnings.push(`model:${node.id}: using active session model`);
	}
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

function findWorkflowFamilyByChangeRequest(
	families: WorkflowRunFamilySnapshot[],
	changeRequestId: string,
): WorkflowRunFamilySnapshot | undefined {
	return families.find(family => family.changeRequests.some(request => request.id === changeRequestId));
}

function workflowChangeApprovalDenial(
	family: WorkflowRunFamilySnapshot,
	request: WorkflowChangeRequestRecord,
	actor: string,
): string | undefined {
	const policy = workflowChangePolicy(family, request);
	if (isHumanWorkflowActor(actor)) {
		return policy.humansCanApprove
			? undefined
			: `Workflow change request approval denied: ${actor} requires changePolicy.humansCanApprove`;
	}
	if (isSupervisorWorkflowActor(actor)) {
		return policy.supervisorsCanApprove === true
			? undefined
			: `Workflow change request approval denied: ${actor} requires changePolicy.supervisorsCanApprove`;
	}
	return `Workflow change request approval denied: ${actor} requires human approval or authorized supervisor policy`;
}

function workflowChangeProposalDenial(
	family: WorkflowRunFamilySnapshot,
	request: ProposeWorkflowChangeRequestOptions,
): string | undefined {
	const policy = workflowChangePolicy(family, request);
	if (request.origin === "internal-agent" && !policy.agentsCanPropose) {
		return `Workflow change request proposal denied: ${request.actor} requires changePolicy.agentsCanPropose`;
	}
	return undefined;
}

function workflowChangePolicy(
	family: WorkflowRunFamilySnapshot,
	target: WorkflowChangePolicyTarget,
): WorkflowChangePolicy {
	const policy = workflowFreezeForChangeTarget(family, target)?.changePolicy;
	return {
		agentsCanPropose: policy?.agentsCanPropose ?? true,
		humansCanApprove: policy?.humansCanApprove ?? true,
		...(policy?.supervisorsCanApprove !== undefined ? { supervisorsCanApprove: policy.supervisorsCanApprove } : {}),
	};
}

interface WorkflowChangePolicyTarget {
	attemptId?: string;
	checkpointId?: string;
}

function workflowFreezeForChangeTarget(
	family: WorkflowRunFamilySnapshot,
	target: WorkflowChangePolicyTarget,
): FlowFreeze | undefined {
	if (target.attemptId !== undefined) {
		const attemptFreeze = workflowFreezeForAttempt(family, target.attemptId);
		if (attemptFreeze !== undefined) return attemptFreeze;
	}
	if (target.checkpointId !== undefined) {
		const checkpoint = family.checkpoints.find(candidate => candidate.id === target.checkpointId);
		if (checkpoint !== undefined) {
			const checkpointFreeze = workflowFreezeForAttempt(family, checkpoint.attemptId);
			if (checkpointFreeze !== undefined) return checkpointFreeze;
		}
	}
	return family.freezes.at(-1);
}

function workflowFreezeForAttempt(family: WorkflowRunFamilySnapshot, attemptId: string): FlowFreeze | undefined {
	const attempt = family.attempts.find(candidate => candidate.id === attemptId);
	if (attempt === undefined) return undefined;
	return family.freezes.find(candidate => candidate.id === attempt.freezeId);
}

function workflowChangeApplicationError(
	family: WorkflowRunFamilySnapshot,
	request: WorkflowChangeRequestRecord,
): string | undefined {
	if (request.checkpointId !== undefined) {
		const checkpoint = family.checkpoints.find(candidate => candidate.id === request.checkpointId);
		if (checkpoint === undefined) return `Workflow change request checkpoint not found: ${request.checkpointId}`;
	}
	if (request.attemptId === undefined) return undefined;
	const attempt = family.attempts.find(candidate => candidate.id === request.attemptId);
	const attemptCheckpoints = family.checkpoints.filter(checkpoint => checkpoint.attemptId === request.attemptId);
	if (attemptCheckpoints.length === 0) {
		return `Workflow change request cannot be applied before checkpointing attempt: ${request.attemptId}`;
	}
	if (attempt !== undefined && attempt.status !== "stopped") {
		return `Workflow change request cannot be applied before stopping attempt: ${attempt.id} (${attempt.status})`;
	}
	return undefined;
}

function workflowChangeFreezeApplicationError(
	request: WorkflowChangeRequestRecord,
	freeze: FlowFreeze,
): string | undefined {
	const nodeIds = new Set(freeze.definition.nodes.map(node => node.id));
	const edges = freeze.definition.edges;
	const modelRoles = freeze.definition.models.roles ?? {};
	for (const operation of request.operations) {
		if (operation.op === "add_node" && !nodeIds.has(operation.node.id)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: added node missing from freeze: ${operation.node.id}`;
		}
		if (operation.op === "remove_node" && nodeIds.has(operation.nodeId)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: removed node still exists in freeze: ${operation.nodeId}`;
		}
		if (operation.op === "add_edge" && !workflowDefinitionHasEdge(edges, operation.edge.from, operation.edge.to)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: added edge missing from freeze: ${operation.edge.from} -> ${operation.edge.to}`;
		}
		if (operation.op === "remove_edge" && workflowDefinitionHasEdge(edges, operation.from, operation.to)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: removed edge still exists in freeze: ${operation.from} -> ${operation.to}`;
		}
		if (operation.op === "replace_edge_condition") {
			const edge = edges.find(candidate => candidate.from === operation.from && candidate.to === operation.to);
			if (edge === undefined) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: changed edge missing from freeze: ${operation.from} -> ${operation.to}`;
			}
			const condition = edge.condition?.source;
			if (condition !== operation.condition) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: edge condition mismatch for ${operation.from} -> ${operation.to}`;
			}
		}
		if (operation.op === "replace_node_prompt_source") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (!node || !workflowJsonEqual(node.promptSource, operation.promptSource)) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: prompt source mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "replace_node_model") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (!node || !workflowJsonEqual(node.model, operation.model)) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: model mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "replace_node_permissions") {
			const node = freeze.definition.nodes.find(candidate => candidate.id === operation.nodeId);
			if (
				!node ||
				!workflowJsonEqual(node.reads ?? [], operation.reads ?? []) ||
				!workflowJsonEqual(node.writes ?? [], operation.writes ?? [])
			) {
				return `Workflow change request cannot be applied to freeze ${freeze.id}: permissions mismatch for node: ${operation.nodeId}`;
			}
		}
		if (operation.op === "set_model_role" && modelRoles[operation.role] !== operation.selector) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: model role mismatch for role: ${operation.role}`;
		}
	}
	for (const [sourceNodeId, targetNodeId] of Object.entries(request.frontierMapping)) {
		void sourceNodeId;
		if (!nodeIds.has(targetNodeId)) {
			return `Workflow change request cannot be applied to freeze ${freeze.id}: frontier target missing from freeze: ${targetNodeId}`;
		}
	}
	return undefined;
}

function workflowDefinitionHasEdge(edges: WorkflowDefinition["edges"], from: string, to: string): boolean {
	return edges.some(edge => edge.from === from && edge.to === to);
}

function workflowJsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
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

function isHumanWorkflowActor(actor: string): boolean {
	return actor === "human" || actor.startsWith("human:");
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

function resolveRestartStartNodeIds(
	checkpoint: WorkflowCheckpointSnapshot,
	freeze: FlowFreeze,
	family: WorkflowRunFamilySnapshot,
): string[] {
	const definition = freeze.definition;
	const nodeIds = new Set(definition.nodes.map(node => node.id));
	const frontierMappings = [
		...approvedCheckpointFrontierMappings(family, checkpoint, freeze.id),
		...migrationFrontierMappings(definition),
	];
	const startNodeIds: string[] = [];
	for (const frontierNodeId of checkpoint.frontierNodeIds) {
		for (const mapped of restartFrontierCandidates(frontierNodeId, checkpoint, frontierMappings)) {
			if (nodeIds.has(mapped)) {
				pushUnique(startNodeIds, mapped);
				break;
			}
		}
	}
	return startNodeIds;
}

function migrationFrontierMappings(definition: WorkflowDefinition): Array<Record<string, string>> {
	return definition.migrations?.map(migration => migration.frontierMapping) ?? [];
}

function approvedCheckpointFrontierMappings(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
	freezeId: string,
): Array<Record<string, string>> {
	return family.changeRequests
		.filter(
			request =>
				request.status === "approved" &&
				(request.checkpointId === undefined || request.checkpointId === checkpoint.id) &&
				(request.attemptId === undefined || request.attemptId === checkpoint.attemptId) &&
				request.applications.some(
					application => application.target === "freeze" && application.freezeId === freezeId,
				),
		)
		.map(request => request.frontierMapping);
}

function checkpointCompletedActivations(
	family: WorkflowRunFamilySnapshot,
	checkpoint: WorkflowCheckpointSnapshot,
): WorkflowActivation[] {
	const completedIds = new Set(checkpoint.completedActivationIds);
	const activations: WorkflowActivation[] = [];
	for (const attempt of family.attempts) {
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
	}
	return activations;
}

function restartFrontierCandidates(
	frontierNodeId: string,
	checkpoint: WorkflowCheckpointSnapshot,
	approvedMappings: Array<Record<string, string>>,
): string[] {
	const candidates: string[] = [];
	for (const mapping of approvedMappings) {
		const mapped = mapping[frontierNodeId];
		if (mapped !== undefined) candidates.push(mapped);
	}
	const savedMapping = checkpoint.sourceMapping[frontierNodeId];
	if (savedMapping !== undefined) candidates.push(savedMapping);
	candidates.push(frontierNodeId);
	return candidates;
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
	if (value.id !== undefined) file.id = expectWorkflowPatchString(value.id, `${filePath}: id`);
	if (value.familyId !== undefined) file.familyId = expectWorkflowPatchString(value.familyId, `${filePath}: familyId`);
	if (value.attemptId !== undefined) {
		file.attemptId = expectWorkflowPatchString(value.attemptId, `${filePath}: attemptId`);
	}
	if (value.checkpointId !== undefined) {
		file.checkpointId = expectWorkflowPatchString(value.checkpointId, `${filePath}: checkpointId`);
	}
	if (value.actor !== undefined) file.actor = expectWorkflowPatchString(value.actor, `${filePath}: actor`);
	if (value.origin !== undefined) {
		if (!isWorkflowChangeRequestOrigin(value.origin)) {
			throw new Error(`${filePath}: origin must be a supported workflow change request origin`);
		}
		file.origin = value.origin;
	}
	if (value.reason !== undefined) file.reason = expectWorkflowPatchString(value.reason, `${filePath}: reason`);
	if (value.operations !== undefined) {
		if (!Array.isArray(value.operations)) throw new Error(`${filePath}: operations must be an array`);
		file.operations = value.operations.map((operation, index) =>
			parseWorkflowGraphPatchOperation(operation, `${filePath}: operations.${index}`),
		);
	}
	if (value.frontierMapping !== undefined) {
		file.frontierMapping = parseWorkflowPatchStringRecord(value.frontierMapping, `${filePath}: frontierMapping`);
	}
	return file;
}

function parseWorkflowGraphPatchOperation(value: unknown, pathLabel: string): WorkflowGraphPatchOperation {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const op = expectWorkflowPatchString(raw.op, `${pathLabel}.op`);
	if (op === "add_node") {
		return {
			op,
			node: parseWorkflowPatchNode(
				raw.node,
				`${pathLabel}.node`,
				"workflow change operation add_node requires node",
			),
		};
	}
	if (op === "remove_node") {
		return { op, nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`) };
	}
	if (op === "add_edge") {
		return {
			op,
			edge: parseWorkflowPatchEdge(
				raw.edge,
				`${pathLabel}.edge`,
				"workflow change operation add_edge requires edge",
			),
		};
	}
	if (op === "remove_edge") {
		return {
			op,
			from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
			to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
		};
	}
	if (op === "replace_edge_condition") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
			to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
		};
		if (raw.condition !== undefined) {
			operation.condition = expectWorkflowPatchString(raw.condition, `${pathLabel}.condition`);
		}
		return operation;
	}
	if (op === "replace_node_prompt_source") {
		return {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
			promptSource: parseWorkflowPatchPromptSource(raw.promptSource, `${pathLabel}.promptSource`),
		};
	}
	if (op === "replace_node_model") {
		return {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
			model: parseRequiredWorkflowPatchModelContext(raw.model, `${pathLabel}.model`),
		};
	}
	if (op === "replace_node_permissions") {
		const operation: WorkflowGraphPatchOperation = {
			op,
			nodeId: expectWorkflowPatchString(raw.nodeId, `${pathLabel}.nodeId`),
		};
		if (raw.reads !== undefined) operation.reads = parseWorkflowPatchStringArray(raw.reads, `${pathLabel}.reads`);
		if (raw.writes !== undefined) {
			operation.writes = parseWorkflowPatchStringArray(raw.writes, `${pathLabel}.writes`);
		}
		return operation;
	}
	if (op === "set_model_role") {
		return {
			op,
			role: expectWorkflowPatchString(raw.role, `${pathLabel}.role`),
			selector: expectWorkflowPatchString(raw.selector, `${pathLabel}.selector`),
		};
	}
	throw new Error(`${pathLabel}: unsupported workflow change operation "${op}"`);
}

function parseWorkflowPatchNode(value: unknown, pathLabel: string, missingMessage?: string): WorkflowNode {
	const raw = expectWorkflowPatchRecord(value, pathLabel, missingMessage);
	const node: WorkflowNode = {
		id: expectWorkflowPatchString(raw.id, `${pathLabel}.id`),
		type: parseWorkflowPatchNodeType(raw.type, `${pathLabel}.type`),
	};
	if (raw.agent !== undefined) node.agent = expectWorkflowPatchString(raw.agent, `${pathLabel}.agent`);
	const model = parseWorkflowPatchModelContext(raw.model, `${pathLabel}.model`);
	if (model !== undefined) node.model = model;
	if (raw.prompt !== undefined && raw.promptSource !== undefined) {
		throw new Error(`${pathLabel} must not define both prompt and promptSource`);
	}
	const prompt = parseWorkflowPatchPrompt(raw.prompt, `${pathLabel}.prompt`);
	if (prompt.prompt !== undefined) node.prompt = prompt.prompt;
	if (prompt.promptSource !== undefined) node.promptSource = prompt.promptSource;
	if (raw.promptSource !== undefined) {
		const promptSource = parseWorkflowPatchPromptSource(raw.promptSource, `${pathLabel}.promptSource`);
		node.promptSource = promptSource;
		const promptText = promptTextForWorkflowPatchSource(promptSource);
		if (promptText === undefined) {
			delete node.prompt;
		} else {
			node.prompt = promptText;
		}
	}
	const script = parseWorkflowPatchScriptSource(raw.script, `${pathLabel}.script`);
	if (script !== undefined) node.script = script;
	if (raw.gates !== undefined) node.gates = parseWorkflowPatchStringArray(raw.gates, `${pathLabel}.gates`);
	if (raw.reads !== undefined) node.reads = parseWorkflowPatchStringArray(raw.reads, `${pathLabel}.reads`);
	if (raw.writes !== undefined) node.writes = parseWorkflowPatchStringArray(raw.writes, `${pathLabel}.writes`);
	if (raw.waitFor !== undefined) node.waitFor = parseWorkflowPatchStringArray(raw.waitFor, `${pathLabel}.waitFor`);
	return node;
}

function parseWorkflowPatchEdge(value: unknown, pathLabel: string, missingMessage?: string): WorkflowEdge {
	const raw = expectWorkflowPatchRecord(value, pathLabel, missingMessage);
	const edge: WorkflowEdge = {
		from: expectWorkflowPatchString(raw.from, `${pathLabel}.from`),
		to: expectWorkflowPatchString(raw.to, `${pathLabel}.to`),
	};
	if (raw.condition !== undefined && raw.when !== undefined) {
		throw new Error(`${pathLabel} must not define both condition and when`);
	}
	const condition = parseWorkflowPatchEdgeCondition(
		raw.condition !== undefined ? raw.condition : raw.when,
		`${pathLabel}.condition`,
	);
	if (condition !== undefined) edge.condition = condition;
	return edge;
}

function parseWorkflowPatchEdgeCondition(value: unknown, pathLabel: string): WorkflowEdge["condition"] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { source: expectWorkflowPatchString(value, pathLabel) };
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	return { source: expectWorkflowPatchString(raw.source, `${pathLabel}.source`) };
}

function parseWorkflowPatchNodeType(value: unknown, pathLabel: string): WorkflowNodeType {
	if (value === "agent" || value === "script" || value === "human" || value === "review") return value;
	throw new Error(`${pathLabel} must be agent, script, human, or review`);
}

function parseWorkflowPatchPrompt(
	value: unknown,
	pathLabel: string,
): { prompt?: string; promptSource?: WorkflowPromptSource } {
	if (value === undefined) return {};
	if (typeof value === "string") {
		const prompt = expectWorkflowPatchString(value, pathLabel);
		return {
			prompt,
			promptSource: prompt.startsWith("./") ? { kind: "file", path: prompt } : { kind: "inline", text: prompt },
		};
	}
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const sourceKeys = ["inline", "file", "state", "output", "human"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new Error(`${pathLabel} must define exactly one of inline, file, state, output, or human`);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		const text = expectWorkflowPatchString(raw.inline, `${pathLabel}.inline`);
		return { prompt: text, promptSource: { kind: "inline", text } };
	}
	if (sourceKey === "file") {
		const filePath = expectWorkflowPatchString(raw.file, `${pathLabel}.file`);
		return { prompt: filePath, promptSource: { kind: "file", path: filePath } };
	}
	if (sourceKey === "state") {
		return { promptSource: { kind: "state", path: expectWorkflowPatchJsonPointer(raw.state, `${pathLabel}.state`) } };
	}
	if (sourceKey === "human") {
		return { promptSource: { kind: "human", path: expectWorkflowPatchJsonPointer(raw.human, `${pathLabel}.human`) } };
	}
	const output = expectWorkflowPatchRecord(raw.output, `${pathLabel}.output`);
	return {
		promptSource: {
			kind: "output",
			node: expectWorkflowPatchString(output.node, `${pathLabel}.output.node`),
			path: expectWorkflowPatchJsonPointer(output.path, `${pathLabel}.output.path`),
			activation: parseWorkflowPatchPromptActivationSelector(output.activation, `${pathLabel}.output.activation`),
		},
	};
}

function parseWorkflowPatchPromptSource(value: unknown, pathLabel: string): WorkflowPromptSource {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const kind = expectWorkflowPatchString(raw.kind, `${pathLabel}.kind`);
	if (kind === "inline") {
		return { kind, text: expectWorkflowPatchString(raw.text, `${pathLabel}.text`) };
	}
	if (kind === "file") {
		return { kind, path: expectWorkflowPatchString(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "state") {
		return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "human") {
		return { kind, path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`) };
	}
	if (kind === "output") {
		return {
			kind,
			node: expectWorkflowPatchString(raw.node, `${pathLabel}.node`),
			path: expectWorkflowPatchJsonPointer(raw.path, `${pathLabel}.path`),
			activation: parseWorkflowPatchPromptActivationSelector(raw.activation, `${pathLabel}.activation`),
		};
	}
	throw new Error(`${pathLabel}.kind must be inline, file, state, output, or human`);
}

function parseWorkflowPatchPromptActivationSelector(
	value: unknown,
	pathLabel: string,
): WorkflowPromptActivationSelector {
	if (value === "parent" || value === "latest-completed") return value;
	throw new Error(`${pathLabel} must be parent or latest-completed`);
}

function parseWorkflowPatchScriptSource(value: unknown, pathLabel: string): WorkflowScriptSource | undefined {
	if (value === undefined) return undefined;
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const script: WorkflowScriptSource = {};
	const language = parseWorkflowPatchScriptLanguage(raw.language, `${pathLabel}.language`);
	if (language !== undefined) script.language = language;
	if (raw.inline !== undefined && raw.code !== undefined) {
		throw new Error(`${pathLabel} must not define both inline and code`);
	}
	const inlineOrCode = raw.code !== undefined ? raw.code : raw.inline;
	const sourceCount = [inlineOrCode !== undefined, raw.file !== undefined].filter(Boolean).length;
	if (sourceCount !== 1) {
		throw new Error(`${pathLabel} must define exactly one of inline, code, or file`);
	}
	if (inlineOrCode !== undefined) script.code = expectWorkflowPatchString(inlineOrCode, `${pathLabel}.code`);
	if (raw.file !== undefined) script.file = expectWorkflowPatchString(raw.file, `${pathLabel}.file`);
	return script;
}

function parseWorkflowPatchScriptLanguage(value: unknown, pathLabel: string): WorkflowScriptLanguage | undefined {
	if (value === undefined) return undefined;
	if (value === "js" || value === "py" || value === "sh") return value;
	throw new Error(`${pathLabel} must be js, py, or sh`);
}

function parseRequiredWorkflowPatchModelContext(value: unknown, pathLabel: string): WorkflowModelContext {
	const model = parseWorkflowPatchModelContext(value, pathLabel);
	if (model !== undefined) return model;
	throw new Error(`${pathLabel} must define a workflow model context`);
}

function parseWorkflowPatchModelContext(value: unknown, pathLabel: string): WorkflowModelContext | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { selector: expectWorkflowPatchString(value, pathLabel) };
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const role = parseOptionalWorkflowPatchString(raw.role, `${pathLabel}.role`);
	const selector = parseOptionalWorkflowPatchString(raw.selector, `${pathLabel}.selector`);
	const candidates = parseOptionalWorkflowPatchStringArray(raw.candidates, `${pathLabel}.candidates`);
	const unavailable = parseWorkflowPatchModelUnavailable(raw.unavailable, `${pathLabel}.unavailable`);
	if (candidates !== undefined && candidates.length === 0) {
		throw new Error(`${pathLabel}.candidates must not be empty`);
	}
	const sourceCount = [role, selector, candidates].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new Error(`${pathLabel} must define exactly one of role, selector, or candidates`);
	}
	const model: WorkflowModelContext = {};
	if (role !== undefined) model.role = role;
	if (selector !== undefined) model.selector = selector;
	if (candidates !== undefined) model.candidates = candidates;
	if (unavailable !== undefined) model.unavailable = unavailable;
	return model;
}

function parseWorkflowPatchModelUnavailable(
	value: unknown,
	pathLabel: string,
): WorkflowModelUnavailablePolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "fallback-to-parent" || value === "fail") return value;
	throw new Error(`${pathLabel} must be "fallback-to-parent" or "fail"`);
}

function parseOptionalWorkflowPatchString(value: unknown, pathLabel: string): string | undefined {
	if (value === undefined) return undefined;
	return expectWorkflowPatchString(value, pathLabel);
}

function parseOptionalWorkflowPatchStringArray(value: unknown, pathLabel: string): string[] | undefined {
	if (value === undefined) return undefined;
	return parseWorkflowPatchStringArray(value, pathLabel);
}

function parseWorkflowPatchStringArray(value: unknown, pathLabel: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${pathLabel} must be an array of strings`);
	return value.map((entry, index) => expectWorkflowPatchString(entry, `${pathLabel}.${index}`));
}

function parseWorkflowPatchStringRecord(value: unknown, pathLabel: string): Record<string, string> {
	const raw = expectWorkflowPatchRecord(value, pathLabel);
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(raw)) {
		record[key] = expectWorkflowPatchString(entry, `${pathLabel}.${key}`);
	}
	return record;
}

function expectWorkflowPatchJsonPointer(value: unknown, pathLabel: string): string {
	const pointer = expectWorkflowPatchString(value, pathLabel);
	if (pointer.startsWith("/")) return pointer;
	throw new Error(`${pathLabel} must be a JSON pointer`);
}

function expectWorkflowPatchString(value: unknown, pathLabel: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new Error(`${pathLabel} must be a non-empty string`);
}

function expectWorkflowPatchRecord(
	value: unknown,
	pathLabel: string,
	missingMessage?: string,
): Record<string, unknown> {
	if (value === undefined && missingMessage !== undefined) throw new Error(missingMessage);
	if (isRecord(value)) return value;
	throw new Error(`${pathLabel} must be an object`);
}

function promptTextForWorkflowPatchSource(source: WorkflowPromptSource): string | undefined {
	if (source.kind === "inline") return source.text;
	if (source.kind === "file") return source.path;
	return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowUsage(): string {
	return [
		"Usage: /workflow inspect",
		"Usage: /workflow list [--family-id <id>]",
		"Usage: /workflow graph [--family-id <id>]",
		"Usage: /workflow manager [--family-id <id>]",
		"Usage: /workflow freeze <path> [--family-id <id>]",
		"Usage: /workflow start <path> [--run-id <id>] [--family-id <id>] [--start <node-id>] [--max-activations <n>] [--max-node-activations <n>] [--background]",
		"Usage: /workflow request-change <file> [--family-id <id>] [--attempt-id <id>]",
		"Usage: /workflow approve-change <change-request-id> [--actor <actor>]",
		"Usage: /workflow reject-change <change-request-id> [--actor <actor>] [--reason <text>]",
		"Usage: /workflow apply-change <change-request-id> (--freeze-id <id>|--draft-id <id>|--draft-path <path>) [--actor <actor>] [--reason <text>]",
		"Usage: /workflow stop <attempt-id> [--deadline-ms <n>]",
		"Usage: /workflow restart <checkpoint-id> [--freeze-id <id>]",
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

function formatWorkflowManager(family: WorkflowRunFamilySnapshot): string {
	const lines = [`Workflow manager: ${family.id}`];
	if (family.objective !== undefined) lines.push(`Objective: ${family.objective}`);
	const currentAttempt = family.attempts.at(-1);
	const latestFreeze = family.freezes.at(-1);
	const latestCheckpoint = family.checkpoints.at(-1);
	lines.push("Focus:");
	if (currentAttempt !== undefined) {
		const checkpoint = currentAttempt.checkpointId ? ` from ${currentAttempt.checkpointId}` : "";
		lines.push(
			`- current attempt: ${currentAttempt.id} ${currentAttempt.status} freeze=${currentAttempt.freezeId}${checkpoint}`,
		);
	} else {
		lines.push("- current attempt: none");
	}
	lines.push(`- latest freeze: ${latestFreeze?.id ?? "none"}`);
	if (latestCheckpoint !== undefined) {
		lines.push(
			`- latest checkpoint: ${latestCheckpoint.id} frontier=${latestCheckpoint.frontierNodeIds.join(", ") || "none"}`,
		);
	} else {
		lines.push("- latest checkpoint: none");
	}
	lines.push("Change review:");
	if (family.changeRequests.length === 0) {
		lines.push("- none");
	} else {
		for (const request of family.changeRequests) {
			lines.push(formatWorkflowManagerChangeRequest(request));
			for (const operation of request.operations) {
				lines.push(`  op: ${formatWorkflowManagerOperation(operation)}`);
			}
			if (request.status === "proposed") {
				lines.push(`  approve: /workflow approve-change ${request.id} --actor human`);
				lines.push(`  reject: /workflow reject-change ${request.id} --actor human --reason <reason>`);
			}
			if (request.status === "approved" && latestFreeze !== undefined) {
				lines.push(`  apply: /workflow apply-change ${request.id} --freeze-id ${latestFreeze.id} --actor human`);
			}
		}
	}
	lines.push("Runtime bindings:");
	if (family.attempts.length === 0) {
		lines.push("- none");
	} else {
		for (const attempt of family.attempts) {
			lines.push(formatWorkflowManagerBinding(attempt));
			for (const warning of attempt.runtimeBindingSnapshot.warnings) lines.push(`  warning: ${warning}`);
			for (const unavailable of attempt.runtimeBindingSnapshot.unavailable) {
				lines.push(`  unavailable: ${unavailable}`);
			}
		}
	}
	lines.push("Operator actions:");
	lines.push(`- graph: /workflow graph --family-id ${family.id}`);
	if (currentAttempt?.status === "running") {
		lines.push(`- interrupt: /workflow stop ${currentAttempt.id} --deadline-ms 30000`);
	}
	for (const checkpoint of family.checkpoints) {
		const freezeSuffix = latestFreeze === undefined ? "" : ` --freeze-id ${latestFreeze.id}`;
		lines.push(`- restart: /workflow restart ${checkpoint.id}${freezeSuffix}`);
	}
	lines.push(`- request change: /workflow request-change <file> --family-id ${family.id}`);
	return lines.join("\n");
}

function formatWorkflowManagerChangeRequest(request: WorkflowChangeRequestRecord): string {
	const approval = request.approvedBy ? ` approvedBy=${request.approvedBy}` : "";
	const rejection = request.rejectedBy ? ` rejectedBy=${request.rejectedBy}` : "";
	const applied =
		request.applications.length > 0 ? ` applied=${formatWorkflowChangeApplications(request.applications)}` : "";
	return `- ${request.id} ${request.status} ${request.origin} actor=${request.actor} ops=${request.operations.length}${approval}${rejection}${applied} - ${request.reason}`;
}

function formatWorkflowManagerOperation(operation: WorkflowGraphPatchOperation): string {
	if (operation.op === "add_node") return `add_node ${operation.node.id}`;
	if (operation.op === "remove_node") return `remove_node ${operation.nodeId}`;
	if (operation.op === "add_edge") return `add_edge ${operation.edge.from} -> ${operation.edge.to}`;
	if (operation.op === "remove_edge") return `remove_edge ${operation.from} -> ${operation.to}`;
	if (operation.op === "replace_edge_condition") {
		return `replace_edge_condition ${operation.from} -> ${operation.to}`;
	}
	if (operation.op === "replace_node_prompt_source") {
		return `replace_node_prompt_source ${operation.nodeId}`;
	}
	if (operation.op === "replace_node_model") return `replace_node_model ${operation.nodeId}`;
	if (operation.op === "replace_node_permissions") return `replace_node_permissions ${operation.nodeId}`;
	if (operation.op === "set_model_role") return `set_model_role ${operation.role}`;
	return operation satisfies never;
}

function formatWorkflowManagerBinding(attempt: WorkflowRunAttemptSnapshot): string {
	const binding = attempt.runtimeBindingSnapshot;
	return `- ${attempt.id} ${binding.id} tools=${formatWorkflowManagerList(binding.tools)} agents=${formatWorkflowManagerList(binding.agents)} models=${formatWorkflowManagerModels(binding.resolvedModels)}`;
}

function formatWorkflowManagerModels(models: Record<string, string>): string {
	const entries = Object.entries(models);
	if (entries.length === 0) return "none";
	return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function formatWorkflowManagerList(values: string[]): string {
	return values.length === 0 ? "none" : values.join(",");
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
	return condition === undefined ? "" : ` when ${condition}`;
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
