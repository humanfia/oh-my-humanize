import { describe, expect, it } from "bun:test";
import {
	approveWorkflowChangeRequest,
	completeWorkflowAttempt,
	proposeWorkflowChangeRequest,
	type RuntimeBindingSnapshot,
	reconstructWorkflowFamilies,
	recordWorkflowChangeRequestApplied,
	startWorkflowAttempt,
	startWorkflowFamily,
	WORKFLOW_LIFECYCLE_EVENT_TYPE,
	type WorkflowLifecycleBranchEntry,
	WorkflowLifecycleError,
	workflowLifecycleStoreEntries,
} from "../lifecycle";
import type { WorkflowGraphPatchOperation } from "../patches";

describe("workflow lifecycle", () => {
	it("keeps repeated identical change proposals idempotent after approval", () => {
		const host = new MemoryWorkflowHost();
		startWorkflowFamily(host, { familyId: "family-1" });
		const proposal = changeProposal("repair review route");

		proposeWorkflowChangeRequest(host, proposal);
		approveWorkflowChangeRequest(host, { changeRequestId: proposal.changeRequestId, actor: "human:operator" });
		proposeWorkflowChangeRequest(host, proposal);
		const application = recordWorkflowChangeRequestApplied(host, {
			changeRequestId: proposal.changeRequestId,
			actor: "human:operator",
			target: "draft",
		});

		expect(application.target).toBe("draft");
		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.changeRequests).toHaveLength(1);
		expect(family.changeRequests[0]).toMatchObject({
			id: proposal.changeRequestId,
			status: "approved",
			approvedBy: "human:operator",
			applications: [{ target: "draft", actor: "human:operator" }],
		});
	});

	it("rejects repeated change proposal ids with different content", () => {
		const host = new MemoryWorkflowHost();
		startWorkflowFamily(host, { familyId: "family-1" });
		const proposal = changeProposal("repair review route");

		proposeWorkflowChangeRequest(host, proposal);

		expect(() =>
			proposeWorkflowChangeRequest(host, {
				...proposal,
				reason: "different repair",
			}),
		).toThrow(WorkflowLifecycleError);
		const family = reconstructWorkflowFamilies(host.getBranch())[0]!;
		expect(family.changeRequests).toHaveLength(1);
		expect(family.changeRequests[0]?.reason).toBe("repair review route");
	});

	it("keeps background lifecycle attempts visible after the conversational branch moves", () => {
		const host = new BranchingWorkflowHost();
		startWorkflowFamily(host, { familyId: "family-1" });
		startWorkflowAttempt(host, {
			familyId: "family-1",
			attemptId: "attempt-1",
			freezeId: "freeze-1",
			startNodeId: "build",
			runtimeBindingSnapshot: runtimeBinding("binding-1"),
		});
		host.moveConversationalBranchPastWorkflowStart();

		completeWorkflowAttempt(host, { attemptId: "attempt-1", summary: "done" });

		expect(reconstructWorkflowFamilies(host.getBranch())).toHaveLength(0);
		const family = reconstructWorkflowFamilies(workflowLifecycleStoreEntries(host))[0]!;
		expect(family.attempts[0]).toMatchObject({ id: "attempt-1", status: "completed", summary: "done" });
	});
});

function changeProposal(reason: string) {
	return {
		changeRequestId: "change-review-route",
		familyId: "family-1",
		actor: "agent:reviewer",
		origin: "internal-agent" as const,
		reason,
		operations: [
			{
				op: "remove_edge",
				from: "review",
				to: "build",
			},
		] satisfies WorkflowGraphPatchOperation[],
		frontierMapping: {
			build: "review",
		},
	};
}

class MemoryWorkflowHost {
	#entries: WorkflowLifecycleBranchEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		this.#entries.push({ type: "custom", customType, data });
		return `${WORKFLOW_LIFECYCLE_EVENT_TYPE}:${this.#entries.length}`;
	}

	getBranch(): WorkflowLifecycleBranchEntry[] {
		return [...this.#entries];
	}
}

class BranchingWorkflowHost {
	#entries: WorkflowLifecycleBranchEntry[] = [];
	#branchStart = 0;

	appendCustomEntry(customType: string, data?: unknown): string {
		this.#entries.push({ type: "custom", customType, data });
		return `${WORKFLOW_LIFECYCLE_EVENT_TYPE}:${this.#entries.length}`;
	}

	getBranch(): WorkflowLifecycleBranchEntry[] {
		return this.#entries.slice(this.#branchStart);
	}

	getEntries(): WorkflowLifecycleBranchEntry[] {
		return [...this.#entries];
	}

	moveConversationalBranchPastWorkflowStart(): void {
		this.#branchStart = this.#entries.length;
	}
}

function runtimeBinding(id: string): RuntimeBindingSnapshot {
	return {
		id,
		requestedRoles: {},
		resolvedModels: {},
		tools: [],
		agents: [],
		unavailable: [],
		warnings: [],
	};
}
