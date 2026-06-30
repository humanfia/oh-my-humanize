import { describe, expect, it } from "bun:test";
import { applyWorkflowStatePatch, readWorkflowState, validateWorkflowActivationOutput } from "../../src/workflow/state";

describe("workflow structured state and artifacts", () => {
	it("applies writes inside allowed scopes and rejects writes outside them", () => {
		const state: Record<string, unknown> = {};

		applyWorkflowStatePatch(state, [{ op: "set", path: "/review/verdict", value: "continue" }], {
			allowedWritePaths: ["/review"],
		});

		expect(state).toEqual({ review: { verdict: "continue" } });
		expect(() =>
			applyWorkflowStatePatch(state, [{ op: "set", path: "/private/token", value: "secret" }], {
				allowedWritePaths: ["/review"],
			}),
		).toThrow('workflow state write to "/private/token" is not allowed');
	});

	it("rejects conflicting writes to the same state path before mutating state", () => {
		const state: Record<string, unknown> = {};

		expect(() =>
			applyWorkflowStatePatch(
				state,
				[
					{ op: "set", path: "/review/verdict", value: "continue" },
					{ op: "set", path: "/review/verdict", value: "finish" },
				],
				{ allowedWritePaths: ["/review"] },
			),
		).toThrow('workflow state patch writes "/review/verdict" more than once');
		expect(state).toEqual({});
		expect(() =>
			validateWorkflowActivationOutput(
				{
					statePatch: [
						{ op: "set", path: "/review/verdict", value: "continue" },
						{ op: "set", path: "/review/verdict", value: "finish" },
					],
				},
				{ allowedWritePaths: ["/review"] },
			),
		).toThrow('workflow state patch writes "/review/verdict" more than once');
	});

	it("enforces declared state schema before mutating state", () => {
		const state: Record<string, unknown> = {};
		const stateSchema = {
			version: 1,
			shape: {
				review: "object",
				verdict: "string",
			},
		} as const;

		applyWorkflowStatePatch(
			state,
			[
				{ op: "set", path: "/review/verdict", value: "continue" },
				{ op: "set", path: "/verdict", value: "continue" },
			],
			{ stateSchema },
		);

		expect(state).toEqual({ review: { verdict: "continue" }, verdict: "continue" });
		expect(() =>
			applyWorkflowStatePatch(
				state,
				[
					{ op: "set", path: "/review/score", value: 0.92 },
					{ op: "set", path: "/verdict", value: { status: "continue" } },
				],
				{ stateSchema },
			),
		).toThrow('workflow state schema rejects write to "/verdict": expected string, received object');
		expect(state).toEqual({ review: { verdict: "continue" }, verdict: "continue" });
		expect(() =>
			applyWorkflowStatePatch(state, [{ op: "set", path: "/verdict/reason", value: "still failing" }], {
				stateSchema,
			}),
		).toThrow(
			'workflow state schema rejects write to "/verdict/reason": "/verdict" is string and cannot contain children',
		);
		expect(() =>
			applyWorkflowStatePatch(state, [{ op: "set", path: "/unknown", value: true }], { stateSchema }),
		).toThrow('workflow state schema rejects write to "/unknown": top-level field "unknown" is not declared');
	});

	it("reads state inside allowed scopes and rejects reads outside them", () => {
		const state = {
			review: { verdict: "continue" },
			private: { token: "secret" },
		};

		expect(readWorkflowState(state, "/review/verdict", { allowedReadPaths: ["/review"] })).toBe("continue");
		expect(() => readWorkflowState(state, "/private/token", { allowedReadPaths: ["/review"] })).toThrow(
			'workflow state read from "/private/token" is not allowed',
		);
	});

	it("rejects large inline state values before they enter workflow state", () => {
		expect(() =>
			validateWorkflowActivationOutput(
				{
					summary: "short summary",
					statePatch: [{ op: "set", path: "/review/body", value: "x".repeat(65) }],
				},
				{
					allowedWritePaths: ["/review"],
					maxInlineValueBytes: 64,
				},
			),
		).toThrow('workflow state value at "/review/body" exceeds the inline size limit');
	});

	it("keeps compact structured activation data and rejects oversized data", () => {
		expect(
			validateWorkflowActivationOutput(
				{
					summary: "review completed",
					data: { verdict: "continue", score: 0.82 },
				},
				{ maxInlineValueBytes: 64 },
			),
		).toEqual({
			summary: "review completed",
			data: { verdict: "continue", score: 0.82 },
		});

		expect(() =>
			validateWorkflowActivationOutput(
				{
					data: { body: "x".repeat(65) },
				},
				{ maxInlineValueBytes: 64 },
			),
		).toThrow('workflow activation output data at "/data" exceeds the inline size limit');
	});

	it("accepts compact artifact references and rejects raw transcript fields", () => {
		expect(
			validateWorkflowActivationOutput(
				{
					summary: "full output stored separately",
					artifacts: [
						"artifact://workflow/run-1/review.txt",
						"agent-output://activation-1/output",
						"workflow-output/review.md",
					],
				},
				{ allowedWritePaths: [] },
			),
		).toEqual({
			summary: "full output stored separately",
			artifacts: [
				"artifact://workflow/run-1/review.txt",
				"agent-output://activation-1/output",
				"workflow-output/review.md",
			],
		});

		expect(() =>
			validateWorkflowActivationOutput(
				{
					summary: "escaped workspace",
					artifacts: ["../review.md"],
				},
				{ allowedWritePaths: [] },
			),
		).toThrow("workflow artifact reference must use a supported scheme");

		expect(() =>
			validateWorkflowActivationOutput(
				{
					summary: "full transcript follows",
					transcript: "raw transcript body",
				},
				{ allowedWritePaths: [] },
			),
		).toThrow("workflow activation output must store transcripts as artifact references");
	});
});
