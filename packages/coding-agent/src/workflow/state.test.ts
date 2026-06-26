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

	it("rejects relative artifact references without an explicit scheme", () => {
		expect(() =>
			validateWorkflowActivationOutput({
				summary: "wrote transcript",
				artifacts: ["workflow-output/transcript.jsonl"],
			}),
		).toThrow("workflow artifact reference must use a supported scheme");
	});
});
