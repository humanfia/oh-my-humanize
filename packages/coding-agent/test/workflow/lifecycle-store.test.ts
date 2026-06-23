import { describe, expect, it } from "bun:test";
import type { FlowFreeze } from "../../src/workflow/freeze";
import {
	appendWorkflowAttemptActivationAborted,
	appendWorkflowAttemptActivationCompleted,
	appendWorkflowAttemptActivationStarted,
	approveWorkflowChangeRequest,
	completeWorkflowAttempt,
	createWorkflowCheckpoint,
	failWorkflowAttempt,
	proposeWorkflowChangeRequest,
	reconstructWorkflowFamilies,
	recordWorkflowChangeRequestApplied,
	recordWorkflowFreeze,
	requestWorkflowAttemptStop,
	restartWorkflowAttempt,
	startWorkflowAttempt,
	startWorkflowFamily,
	type WorkflowLifecycleStoreHost,
} from "../../src/workflow/lifecycle";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

function createHost(): WorkflowLifecycleStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

describe("workflow lifecycle event store", () => {
	it("reconstructs a family with immutable attempts, checkpoint restart, change approval, and runtime bindings", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:b", ["build", "verify", "review"]);

		startWorkflowFamily(host, {
			familyId: "family-1",
			objective: "ship release",
		});
		recordWorkflowFreeze(host, freezeA);
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: {
				id: "binding-1",
				requestedRoles: { builder: "openai/gpt-4o" },
				resolvedModels: { builder: "openai/gpt-4o" },
				tools: ["task"],
				agents: ["task"],
				unavailable: [],
				warnings: [],
			},
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			output: { summary: "built", artifacts: ["artifact://workflow/family-1/build.txt"] },
		});
		const changeRequest = proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "insert deterministic verification before review",
			operations: [
				{
					op: "add_node",
					node: { id: "verify", type: "script" },
				},
			],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, {
			changeRequestId: changeRequest.id,
			actor: "human:sihao",
			reason: "verification is required",
		});
		requestWorkflowAttemptStop(host, {
			attemptId: "attempt-1",
			deadlineMs: 10,
			reason: "approved change request change-1",
		});
		appendWorkflowAttemptActivationAborted(host, {
			attemptId: "attempt-1",
			activationId: "activation-2",
			nodeId: "review",
			reason: "stop deadline elapsed",
		});
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: ["activation-1"],
			abortedActivationIds: ["activation-2"],
			frontierNodeIds: ["review"],
			state: { build: { summary: "built" } },
			sourceMapping: { review: "verify" },
		});
		recordWorkflowFreeze(host, freezeB);
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: changeRequest.id,
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
			reason: "strict freeze passed",
		});
		restartWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-2",
			checkpointId: "checkpoint-1",
			freezeId: freezeB.id,
			startNodeId: "verify",
			runtimeBindingSnapshot: {
				id: "binding-2",
				requestedRoles: { builder: "openai/gpt-4o" },
				resolvedModels: { builder: "openai/gpt-4o" },
				tools: ["task", "eval"],
				agents: ["task"],
				unavailable: [],
				warnings: [],
			},
		});
		completeWorkflowAttempt(host, {
			attemptId: "attempt-2",
			summary: "release verified",
		});

		const reconstructed = reconstructWorkflowFamilies(host.getBranch());

		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]?.id).toBe("family-1");
		expect(reconstructed[0]?.freezes.map(freeze => freeze.id)).toEqual(["flowfreeze:a", "flowfreeze:b"]);
		expect(reconstructed[0]?.attempts.map(attempt => [attempt.id, attempt.freezeId, attempt.status])).toEqual([
			["attempt-1", "flowfreeze:a", "stopped"],
			["attempt-2", "flowfreeze:b", "completed"],
		]);
		expect(reconstructed[0]?.attempts.map(attempt => attempt.runtimeBindingSnapshot.id)).toEqual([
			"binding-1",
			"binding-2",
		]);
		expect(reconstructed[0]?.checkpoints).toEqual([
			{
				id: "checkpoint-1",
				familyId: "family-1",
				attemptId: "attempt-1",
				completedActivationIds: ["activation-1"],
				abortedActivationIds: ["activation-2"],
				frontierNodeIds: ["review"],
				state: { build: { summary: "built" } },
				sourceMapping: { review: "verify" },
			},
		]);
		expect(reconstructed[0]?.changeRequests).toMatchObject([
			{
				id: "change-1",
				status: "approved",
				actor: "agent:reviewer",
				approvedBy: "human:sihao",
				frontierMapping: { review: "verify" },
				applications: [
					{
						actor: "human:sihao",
						target: "freeze",
						freezeId: "flowfreeze:b",
						reason: "strict freeze passed",
					},
				],
			},
		]);
		expect(reconstructed[0]?.attempts[0]?.activations.map(activation => [activation.id, activation.status])).toEqual([
			["activation-1", "completed"],
			["activation-2", "aborted"],
		]);
	});

	it("assigns frozen flows to explicit families when lifecycle histories are interleaved", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:family-a", ["build"]);
		const freezeB = createFreeze("flowfreeze:family-b", ["review"]);

		startWorkflowFamily(host, { familyId: "family-a" });
		startWorkflowFamily(host, { familyId: "family-b" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-a" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-b" });

		const reconstructed = reconstructWorkflowFamilies(host.getBranch());

		expect(reconstructed.map(family => [family.id, family.freezes.map(freeze => freeze.id)])).toEqual([
			["family-a", ["flowfreeze:family-a"]],
			["family-b", ["flowfreeze:family-b"]],
		]);
	});

	it("merges duplicate family creation events without dropping earlier history", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:first", ["build"]);
		const freezeB = createFreeze("flowfreeze:second", ["review"]);

		startWorkflowFamily(host, { familyId: "family-1", objective: "first objective" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		startWorkflowFamily(host, { familyId: "family-1", objective: "second objective" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });

		const reconstructed = reconstructWorkflowFamilies(host.getBranch());

		expect(reconstructed).toHaveLength(1);
		expect(reconstructed[0]?.objective).toBe("first objective");
		expect(reconstructed[0]?.freezes.map(freeze => freeze.id)).toEqual(["flowfreeze:first", "flowfreeze:second"]);
	});

	it("deduplicates repeated freeze records for the same family during reconstruction", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:a", ["build"]);
		const freezeB = createFreeze("flowfreeze:b", ["verify"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });

		const reconstructed = reconstructWorkflowFamilies(host.getBranch());

		expect(reconstructed[0]?.freezes.map(freeze => freeze.id)).toEqual(["flowfreeze:a", "flowfreeze:b"]);
	});

	it("rejects duplicate attempt ids before appending lifecycle events", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		const entryCount = host.entries.length;

		expect(() =>
			startWorkflowAttempt(host, {
				familyId: "family-1",
				attemptId: "attempt-1",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-duplicate"),
			}),
		).toThrow("Workflow attempt already exists: attempt-1");
		expect(host.entries).toHaveLength(entryCount);
		expect(reconstructWorkflowFamilies(host.getBranch())[0]?.attempts.map(attempt => attempt.id)).toEqual([
			"attempt-1",
		]);
	});

	it("rejects lifecycle change application until the request is approved", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			actor: "human:sihao",
			origin: "human",
			reason: "add review",
			operations: [{ op: "add_node", node: { id: "review", type: "review" } }],
		});
		const entryCount = host.entries.length;

		expect(() =>
			recordWorkflowChangeRequestApplied(host, {
				changeRequestId: "change-1",
				actor: "human:sihao",
				target: "draft",
				draftId: "draft-1",
			}),
		).toThrow("Workflow change request is not approved: change-1 (proposed)");
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects supervisor approvals unless the frozen change policy grants authority", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build"], {
			agentsCanPropose: true,
			humansCanApprove: true,
			supervisorsCanApprove: false,
		});

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			actor: "agent:planner",
			origin: "internal-agent",
			reason: "add review",
			operations: [{ op: "add_node", node: { id: "review", type: "review" } }],
		});
		const entryCount = host.entries.length;

		expect(() =>
			approveWorkflowChangeRequest(host, {
				changeRequestId: "change-1",
				actor: "supervisor:policy",
			}),
		).toThrow(
			"Workflow change request approval denied: supervisor:policy requires changePolicy.supervisorsCanApprove",
		);
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects attempt-scoped change application before stop and checkpoint", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build", "review"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			actor: "agent:reviewer",
			origin: "internal-agent",
			reason: "insert verification before review",
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, { changeRequestId: "change-1", actor: "human:sihao" });
		const entryCount = host.entries.length;

		expect(() =>
			recordWorkflowChangeRequestApplied(host, {
				changeRequestId: "change-1",
				actor: "human:sihao",
				target: "draft",
				draftId: "draft-1",
			}),
		).toThrow("Workflow change request cannot be applied before checkpointing attempt: attempt-1");
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects family-scoped change application while an attempt is active", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build", "review"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			actor: "human:sihao",
			origin: "human",
			reason: "upgrade review",
			operations: [{ op: "add_node", node: { id: "strongReview", type: "review" } }],
			frontierMapping: { review: "strongReview" },
		});
		approveWorkflowChangeRequest(host, { changeRequestId: "change-1", actor: "human:sihao" });
		const entryCount = host.entries.length;

		expect(() =>
			recordWorkflowChangeRequestApplied(host, {
				changeRequestId: "change-1",
				actor: "human:sihao",
				target: "draft",
				draftId: "draft-1",
			}),
		).toThrow("Workflow change request cannot be applied while family has an active attempt: attempt-1 (running)");
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects stop requests for missing or inactive attempts", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		completeWorkflowAttempt(host, { attemptId: "attempt-1" });
		const entryCount = host.entries.length;

		expect(() => requestWorkflowAttemptStop(host, { attemptId: "missing", deadlineMs: 10 })).toThrow(
			"Workflow attempt not found for stop: missing",
		);
		expect(() => requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 })).toThrow(
			"Workflow attempt cannot be stopped: attempt-1 (completed)",
		);
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects terminal attempt transitions while activations are running or the attempt is terminal", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		const runningEntryCount = host.entries.length;

		expect(() => completeWorkflowAttempt(host, { attemptId: "attempt-1" })).toThrow(
			"Workflow attempt cannot enter completed while activations are running: attempt-1 (activation-1)",
		);
		expect(() => failWorkflowAttempt(host, { attemptId: "attempt-1", error: "failed" })).toThrow(
			"Workflow attempt cannot enter failed while activations are running: attempt-1 (activation-1)",
		);
		expect(host.entries).toHaveLength(runningEntryCount);

		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			output: { summary: "built" },
		});
		completeWorkflowAttempt(host, { attemptId: "attempt-1" });
		const terminalEntryCount = host.entries.length;

		expect(() => failWorkflowAttempt(host, { attemptId: "attempt-1", error: "late failure" })).toThrow(
			"Workflow attempt cannot enter failed from terminal state: attempt-1 (completed)",
		);
		expect(host.entries).toHaveLength(terminalEntryCount);
	});

	it("rejects checkpoints until the attempt is stopped and all activations have settled", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build", "review"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-1",
			activationId: "activation-1",
			nodeId: "build",
			parentActivationIds: [],
		});
		const entryCount = host.entries.length;

		expect(() =>
			createWorkflowCheckpoint(host, {
				checkpointId: "checkpoint-1",
				familyId: "family-1",
				attemptId: "missing",
				completedActivationIds: [],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: {},
				sourceMapping: { review: "review" },
			}),
		).toThrow("Workflow checkpoint attempt not found: missing");
		expect(() =>
			createWorkflowCheckpoint(host, {
				checkpointId: "checkpoint-1",
				familyId: "family-1",
				attemptId: "attempt-1",
				completedActivationIds: [],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: {},
				sourceMapping: { review: "review" },
			}),
		).toThrow("Workflow checkpoint requires a stopped or failed attempt before saving: attempt-1 (running)");
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		expect(() =>
			createWorkflowCheckpoint(host, {
				checkpointId: "checkpoint-1",
				familyId: "family-1",
				attemptId: "attempt-1",
				completedActivationIds: [],
				abortedActivationIds: [],
				frontierNodeIds: ["review"],
				state: {},
				sourceMapping: { review: "review" },
			}),
		).toThrow("Workflow checkpoint attempt still has running activations: activation-1");
		expect(host.entries).toHaveLength(entryCount + 1);
	});

	it("rejects restart into a changed freeze until the approved change has been applied", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:b", ["build", "verify"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: { review: "verify" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			checkpointId: "checkpoint-1",
			actor: "human:sihao",
			origin: "human",
			reason: "restart at verification",
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, { changeRequestId: "change-1", actor: "human:sihao" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		const entryCount = host.entries.length;

		expect(() =>
			restartWorkflowAttempt(host, {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: "checkpoint-1",
				freezeId: freezeB.id,
				startNodeId: "verify",
				runtimeBindingSnapshot: binding("binding-2"),
			}),
		).toThrow("Workflow restart freeze is not applied to checkpoint checkpoint-1: flowfreeze:b");
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects restart start nodes outside the checkpoint frontier", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build", "review"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: { review: "review" },
		});
		const entryCount = host.entries.length;

		expect(() =>
			restartWorkflowAttempt(host, {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: "checkpoint-1",
				freezeId: freeze.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-2"),
			}),
		).toThrow('Workflow restart start node "build" is not reachable from checkpoint frontier: review');
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects changed-freeze restarts that skip the approved frontier mapping", () => {
		const host = createHost();
		const freezeA = createFreeze("flowfreeze:a", ["build", "review"]);
		const freezeB = createFreeze("flowfreeze:b", ["build", "verify"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freezeA, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freezeA.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["review"],
			state: {},
			sourceMapping: { review: "verify" },
		});
		proposeWorkflowChangeRequest(host, {
			changeRequestId: "change-1",
			familyId: "family-1",
			checkpointId: "checkpoint-1",
			actor: "human:sihao",
			origin: "human",
			reason: "restart at verification",
			operations: [{ op: "add_node", node: { id: "verify", type: "script" } }],
			frontierMapping: { review: "verify" },
		});
		approveWorkflowChangeRequest(host, { changeRequestId: "change-1", actor: "human:sihao" });
		recordWorkflowFreeze(host, freezeB, { familyId: "family-1" });
		recordWorkflowChangeRequestApplied(host, {
			changeRequestId: "change-1",
			actor: "human:sihao",
			target: "freeze",
			freezeId: freezeB.id,
		});
		const entryCount = host.entries.length;

		expect(() =>
			restartWorkflowAttempt(host, {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: "checkpoint-1",
				freezeId: freezeB.id,
				startNodeId: "build",
				runtimeBindingSnapshot: binding("binding-2"),
			}),
		).toThrow('Workflow restart start node "build" is not reachable from checkpoint frontier: verify');
		expect(host.entries).toHaveLength(entryCount);
	});

	it("rejects restart requests that omit checkpoint frontier siblings", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:a", ["build", "left", "right"]);

		startWorkflowFamily(host, { familyId: "family-1" });
		recordWorkflowFreeze(host, freeze, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: freeze.id,
			startNodeId: "build",
			runtimeBindingSnapshot: binding("binding-1"),
		});
		requestWorkflowAttemptStop(host, { attemptId: "attempt-1", deadlineMs: 10 });
		createWorkflowCheckpoint(host, {
			checkpointId: "checkpoint-1",
			familyId: "family-1",
			attemptId: "attempt-1",
			completedActivationIds: [],
			abortedActivationIds: [],
			frontierNodeIds: ["left", "right"],
			state: {},
			sourceMapping: { left: "left", right: "right" },
		});
		const entryCount = host.entries.length;

		expect(() =>
			restartWorkflowAttempt(host, {
				familyId: "family-1",
				attemptId: "attempt-2",
				checkpointId: "checkpoint-1",
				freezeId: freeze.id,
				startNodeId: "left",
				runtimeBindingSnapshot: binding("binding-2"),
			}),
		).toThrow("Workflow restart is missing checkpoint frontier start node: right");
		expect(host.entries).toHaveLength(entryCount);
	});
	it("reconstructs mapped activation metadata through started events", () => {
		const host = createHost();
		const freeze = createFreeze("flowfreeze:meta", ["pool", "pool.worker"]);
		startWorkflowFamily(host, { familyId: "family-mapped", objective: "mapped pool" });
		recordWorkflowFreeze(host, freeze);
		startWorkflowAttempt(host, {
			familyId: "family-mapped",
			attemptId: "attempt-mapped",
			freezeId: freeze.id,
			startNodeId: "pool",
			runtimeBindingSnapshot: binding("binding-mapped"),
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-mapped",
			activationId: "activation-pool",
			nodeId: "pool",
			parentActivationIds: [],
		});
		appendWorkflowAttemptActivationStarted(host, {
			attemptId: "attempt-mapped",
			activationId: "activation-worker",
			nodeId: "pool.worker",
			parentActivationIds: ["activation-pool"],
			mapped: {
				poolId: "pool",
				poolActivationId: "activation-pool",
				itemKey: "task-1",
				item: { id: "task-1" },
				phase: "worker",
			},
		});
		appendWorkflowAttemptActivationCompleted(host, {
			attemptId: "attempt-mapped",
			activationId: "activation-worker",
			output: { summary: "worker done" },
		});

		const families = reconstructWorkflowFamilies(host.getBranch());
		const attempt = families[0]?.attempts.find(a => a.id === "attempt-mapped");
		const workerActivation = attempt?.activations.find(a => a.id === "activation-worker");
		expect(workerActivation?.mapped).toEqual({
			poolId: "pool",
			poolActivationId: "activation-pool",
			itemKey: "task-1",
			item: { id: "task-1" },
			phase: "worker",
		});
	});
});

function binding(id: string) {
	return {
		id,
		requestedRoles: { builder: "openai/gpt-4o" },
		resolvedModels: { builder: "openai/gpt-4o" },
		tools: [],
		agents: [],
		unavailable: [],
		warnings: [],
	};
}

function createFreeze(
	id: string,
	nodeIds: string[],
	changePolicy: FlowFreeze["changePolicy"] = { agentsCanPropose: true, humansCanApprove: true },
): FlowFreeze {
	return {
		id,
		schemaVersion: "omhflow/v1",
		flowPath: `${id}.omhflow`,
		resourceDir: id,
		mainContentHash: `sha256:main-${id}`,
		resourceHashes: [],
		resourceSnapshots: [],
		canonicalGraphHash: `sha256:graph-${id}`,
		sourceMapping: {
			workflowBlocks: [{ id: "workflow:0", language: "yaml" }],
			nodes: Object.fromEntries(nodeIds.map(nodeId => [nodeId, { sourceBlock: "workflow:0" }])),
		},
		staticCheckReport: {
			status: "passed",
			checks: [{ name: "fixture", status: "passed" }],
		},
		portableDefaults: {
			models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
		},
		changePolicy,
		definition: {
			name: id,
			version: 1,
			models: { roles: { builder: "openai/gpt-4o" }, defaults: { agent: "builder" } },
			nodes: nodeIds.map(nodeId => ({ id: nodeId, type: nodeId === "verify" ? "script" : "agent" })),
			edges: [],
		},
	};
}
