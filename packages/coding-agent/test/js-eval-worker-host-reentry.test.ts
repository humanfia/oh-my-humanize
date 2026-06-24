import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { WorkerOutbound } from "../src/eval/js/worker-protocol";

type ProbeResult = { kind: "ready" } | { kind: "error"; message: string } | { kind: "timeout" };

describe("JS eval worker host re-entry", () => {
	const packageDir = path.resolve(import.meta.dir, "..");
	const cliPath = path.join(packageDir, "src/cli.ts");

	it("boots the eval worker through the source CLI hidden argv path", async () => {
		const worker = new Worker(cliPath, { type: "module", argv: ["__omp_worker_js_eval"] });
		const { promise, resolve } = Promise.withResolvers<ProbeResult>();
		let settled = false;
		const finish = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		worker.addEventListener("message", event => {
			const msg = event.data as WorkerOutbound;
			if (msg.type === "ready") finish({ kind: "ready" });
			else if (msg.type === "init-failed") finish({ kind: "error", message: msg.error.message });
		});
		worker.addEventListener("error", event => finish({ kind: "error", message: event.message }));

		worker.postMessage({
			type: "init",
			snapshot: { cwd: packageDir, sessionId: "js-eval-worker-host-reentry" },
		});

		try {
			const result = await Promise.race([
				promise,
				Bun.sleep(5_000).then(() => ({ kind: "timeout" }) as ProbeResult),
			]);
			expect(result).toEqual({ kind: "ready" });
		} finally {
			worker.terminate();
		}
	});
});
