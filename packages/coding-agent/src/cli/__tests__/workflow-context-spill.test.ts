import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { spillLargeWorkflowContextEnv, WORKFLOW_CONTEXT_ENV_SPILL_THRESHOLD } from "../workflow-cli";

describe("spillLargeWorkflowContextEnv", () => {
	it("leaves a small context inline in the environment", async () => {
		const env = await spillLargeWorkflowContextEnv({ OMP_WORKFLOW_CONTEXT: '{"small":true}' });
		expect(env.OMP_WORKFLOW_CONTEXT).toBe('{"small":true}');
		expect(env.OMP_WORKFLOW_CONTEXT_FILE).toBeUndefined();
	});

	it("passes through an env without a context untouched", async () => {
		const env = await spillLargeWorkflowContextEnv({ FOO: "bar" });
		expect(env).toEqual({ FOO: "bar" });
	});

	it("spills an oversized context to a temp file and points to it, avoiding E2BIG", async () => {
		// A context larger than the spill threshold would push argv+env past ARG_MAX and make
		// `posix_spawn 'sh'` fail with E2BIG. It must be written to a file instead.
		const bigContext = JSON.stringify({ blob: "x".repeat(WORKFLOW_CONTEXT_ENV_SPILL_THRESHOLD + 1) });
		const env = await spillLargeWorkflowContextEnv({ OMP_WORKFLOW_CONTEXT: bigContext, KEEP: "me" });

		expect(env.OMP_WORKFLOW_CONTEXT).toBeUndefined();
		expect(env.KEEP).toBe("me");
		expect(env.OMP_WORKFLOW_CONTEXT_FILE).toBeDefined();
		const written = await fs.readFile(env.OMP_WORKFLOW_CONTEXT_FILE as string, "utf8");
		expect(written).toBe(bigContext);
		await fs.rm(env.OMP_WORKFLOW_CONTEXT_FILE as string, { force: true });
	});
});
