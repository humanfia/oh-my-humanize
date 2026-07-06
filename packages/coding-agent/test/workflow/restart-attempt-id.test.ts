import { describe, expect, it } from "bun:test";
import { nextWorkflowRestartAttemptId } from "../../src/slash-commands/helpers/workflow";
import type { WorkflowRunAttemptSnapshot, WorkflowRunFamilySnapshot } from "../../src/workflow/lifecycle";

function attempt(id: string): WorkflowRunAttemptSnapshot {
	return {
		id,
		familyId: "family-1",
		freezeId: "freeze-1",
		startNodeId: "build",
		status: "completed",
		runtimeBindingSnapshot: {
			id: "binding-1",
			requestedRoles: {},
			resolvedModels: {},
			tools: [],
			agents: [],
			unavailable: [],
			warnings: [],
		},
		activations: [],
	};
}

function family(id: string, attemptIds: string[]): WorkflowRunFamilySnapshot {
	return {
		id,
		freezes: [],
		attempts: attemptIds.map(attempt),
		checkpoints: [],
		changeRequests: [],
	};
}

describe("nextWorkflowRestartAttemptId", () => {
	it("returns attempt-1 when no attempts exist", () => {
		expect(nextWorkflowRestartAttemptId([family("family-1", [])])).toBe("attempt-1");
	});

	it("continues past the highest existing attempt index within a family", () => {
		expect(nextWorkflowRestartAttemptId([family("family-1", ["attempt-1", "attempt-2"])])).toBe("attempt-3");
	});

	it("does not collide across families that each carry their own attempt-N series", () => {
		// Deriving the next index from a single family's attempts.length + 1 would reuse
		// an attempt id already taken by another reconstructed family. The next id must be
		// unique across all families.
		const families = [family("family-a", ["attempt-1", "attempt-2"]), family("family-b", ["attempt-1"])];
		expect(nextWorkflowRestartAttemptId(families)).toBe("attempt-3");
	});

	it("parses attempt ids that carry a run-id prefix", () => {
		const families = [family("family-1", ["run-x:attempt-4", "run-x:attempt-5"])];
		expect(nextWorkflowRestartAttemptId(families)).toBe("attempt-6");
	});

	it("falls back to a count-based index when existing ids carry no parseable number", () => {
		// Older attempts may use non-numeric ids (e.g. "attempt-old"). The next id must still
		// advance past the count so it does not reuse "attempt-1" for a third attempt.
		const families = [family("family-1", ["attempt-old", "attempt-checkpoint"])];
		expect(nextWorkflowRestartAttemptId(families)).toBe("attempt-3");
	});
});
