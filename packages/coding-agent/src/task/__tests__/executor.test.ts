import { describe, expect, it } from "bun:test";
import { assembleYieldResult, finalizeSubprocessOutput } from "../executor";
import type { YieldItem } from "../types";

const reviewerOutputSchema = {
	type: "object",
	additionalProperties: true,
	properties: {
		overall_correctness: { enum: ["correct", "incorrect"] },
		explanation: { type: "string" },
		confidence: { type: "number" },
	},
	required: ["overall_correctness", "explanation", "confidence"],
};

describe("task executor yield assembly", () => {
	it("treats terminal result yields as the final payload", () => {
		const data = {
			overall_correctness: "correct",
			explanation: "verdict finish\nReview evidence is complete.",
			confidence: 0.94,
		};
		const yieldItems: YieldItem[] = [{ type: "result", data, status: "success" }];

		expect(assembleYieldResult(yieldItems)?.data).toEqual(data);
	});

	it("validates terminal result yields against the output schema without nesting", () => {
		const data = {
			overall_correctness: "correct",
			explanation: "verdict finish\nReview evidence is complete.",
			confidence: 0.94,
		};
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 0,
			stderr: "",
			doneAborted: false,
			signalAborted: false,
			outputSchema: reviewerOutputSchema,
			yieldItems: [{ type: "result", data, status: "success" }],
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.rawOutput)).toEqual(data);
	});
});
