import { describe, expect, it } from "bun:test";
import { validateWorkflowActivationOutput } from "./state";

describe("validateWorkflowActivationOutput", () => {
	it("accepts readable filesystem artifact references", () => {
		const output = validateWorkflowActivationOutput({
			summary: "wrote transcript",
			artifacts: ["/tmp/omh-workflow/transcript.jsonl"],
		});

		expect(output.artifacts).toEqual(["/tmp/omh-workflow/transcript.jsonl"]);
	});

	it("accepts project-local workflow-output artifact references", () => {
		const output = validateWorkflowActivationOutput({
			summary: "wrote transcript",
			artifacts: ["workflow-output/transcript.jsonl"],
		});

		expect(output.artifacts).toEqual(["workflow-output/transcript.jsonl"]);
	});

	it("rejects relative artifact references outside workflow-output", () => {
		expect(() =>
			validateWorkflowActivationOutput({
				summary: "wrote transcript",
				artifacts: ["docs/transcript.jsonl"],
			}),
		).toThrow("workflow artifact reference must use a supported scheme");
	});
});
