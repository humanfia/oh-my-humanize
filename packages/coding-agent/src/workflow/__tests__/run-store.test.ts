import { describe, expect, it } from "bun:test";
import type { CustomEntry, SessionEntry } from "../../session/session-entries";
import type { WorkflowDefinition } from "../definition";
import {
	appendWorkflowActivationStarted,
	reconstructWorkflowRuns,
	startWorkflowRun,
	WORKFLOW_RUN_EVENT_TYPE,
	workflowRunStoreEntries,
} from "../run-store";

type WorkflowRunStoreEntry = Pick<CustomEntry, "type" | "customType" | "data"> | SessionEntry;

describe("workflow run store", () => {
	it("keeps background run events visible after the conversational branch moves", () => {
		const host = new BranchingWorkflowRunHost();
		startWorkflowRun(host, emptyWorkflowDefinition(), { runId: "run-1" });
		host.moveConversationalBranchPastWorkflowStart();

		appendWorkflowActivationStarted(host, "run-1", {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: "run-1:graph-0",
			parentActivationIds: [],
		});

		expect(reconstructWorkflowRuns(host.getBranch())).toHaveLength(0);
		const run = reconstructWorkflowRuns(workflowRunStoreEntries(host))[0]!;
		expect(run.activations[0]).toMatchObject({ id: "activation-1", nodeId: "build", status: "running" });
	});
});

class BranchingWorkflowRunHost {
	#entries: WorkflowRunStoreEntry[] = [];
	#branchStart = 0;

	appendCustomEntry(customType: string, data?: unknown): string {
		this.#entries.push({ type: "custom", customType, data });
		return `${WORKFLOW_RUN_EVENT_TYPE}:${this.#entries.length}`;
	}

	getBranch(): WorkflowRunStoreEntry[] {
		return this.#entries.slice(this.#branchStart);
	}

	getEntries(): WorkflowRunStoreEntry[] {
		return [...this.#entries];
	}

	moveConversationalBranchPastWorkflowStart(): void {
		this.#branchStart = this.#entries.length;
	}
}

function emptyWorkflowDefinition(): WorkflowDefinition {
	return {
		name: "branch-visible-run",
		version: 1,
		models: { roles: {}, defaults: {} },
		nodes: [],
		edges: [],
	};
}
