import { describe, expect, it } from "bun:test";
import {
	approveWorkflowChangeRequest,
	proposeWorkflowChangeRequest,
	reconstructWorkflowFamilies,
	recordWorkflowChangeRequestApplied,
	startWorkflowFamily,
	WORKFLOW_LIFECYCLE_EVENT_TYPE,
	type WorkflowLifecycleBranchEntry,
	WorkflowLifecycleError,
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
