import { afterAll, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeAllKernelSessions, executePython } from "../executor";

describe("python SystemExit handling", () => {
	afterAll(async () => {
		await disposeAllKernelSessions();
	});

	it("treats SystemExit zero as successful completion", async () => {
		using tempDir = TempDir.createSync("@omp-py-system-exit-zero-");

		const result = await executePython('print("validated")\nraise SystemExit(0)', {
			cwd: tempDir.path(),
			sessionId: "system-exit-zero",
			kernelMode: "per-call",
		});
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return;
		}

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("validated");
		expect(result.output).not.toContain("SystemExit");
	});

	it("keeps nonzero SystemExit as an execution error", async () => {
		using tempDir = TempDir.createSync("@omp-py-system-exit-nonzero-");

		const result = await executePython('print("before failure")\nraise SystemExit(2)', {
			cwd: tempDir.path(),
			sessionId: "system-exit-nonzero",
			kernelMode: "per-call",
		});
		if (result.exitCode === undefined && result.cancelled) {
			expect(result.output).toBe("");
			return;
		}

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("before failure");
		expect(result.output).toContain("SystemExit");
	});
});
