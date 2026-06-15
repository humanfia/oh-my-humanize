import { afterEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runWorkflowCommand } from "../workflow-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("workflow CLI", () => {
	it("passes frozen data resources to headless shell script nodes", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-cli-resources-");
		const root = tempDir.path();
		await Bun.write(`${root}/resource-smoke.omhflow`, workflowResourceSmokeFlow());
		await Bun.write(`${root}/resource-smoke/scripts/read-resource.sh`, workflowResourceSmokeScript());
		await Bun.write(`${root}/resource-smoke/data/message.txt`, "resource-ok");
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runWorkflowCommand({
			action: "start",
			args: [`${root}/resource-smoke.omhflow`],
			flags: {
				cwd: root,
				json: true,
				runId: "resource-smoke-run",
			},
		});

		const result = JSON.parse(output.join("").trim()) as {
			run: { status: string; completed: number; failed: number };
			runs: { stateKeys: string[] }[];
		};
		expect(result.run).toMatchObject({ status: "completed", completed: 1, failed: 0 });
		expect(result.runs[0]?.stateKeys).toEqual(["message"]);
	});
});

function workflowResourceSmokeFlow(): string {
	return [
		"---",
		"name: resource-smoke",
		"version: 1",
		"schema: omhflow/v1",
		"resourceDir: resource-smoke",
		"models:",
		"  roles: {}",
		"  defaults: {}",
		"checkpoint:",
		"  stopDeadlineMs: 30000",
		"changePolicy:",
		"  agentsCanPropose: true",
		"  humansCanApprove: true",
		"---",
		"# Resource smoke",
		"",
		"```yaml workflow",
		"stateSchema:",
		"  version: 1",
		"  shape:",
		"    message: string",
		"resources:",
		"  - path: scripts/read-resource.sh",
		"    kind: script",
		"  - path: data/message.txt",
		"    kind: data",
		"sequence:",
		"  - node:",
		"      id: readResource",
		"      type: script",
		"      script:",
		"        language: sh",
		"        file: scripts/read-resource.sh",
		"      writes:",
		"        - /message",
		"```",
	].join("\n");
}

function workflowResourceSmokeScript(): string {
	return [
		"#!/bin/sh",
		"set -eu",
		'message=$(cat "$OMP_WORKFLOW_RESOURCE_DIR/data/message.txt")',
		'printf \'{"summary":"resource observed","statePatch":[{"op":"set","path":"/message","value":"%s"}]}\\n\' "$message"',
	].join("\n");
}
