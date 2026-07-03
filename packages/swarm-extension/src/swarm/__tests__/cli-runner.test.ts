import { describe, expect, it } from "bun:test";
import { runSwarmCli } from "../cli-runner";

class ExitError extends Error {
	readonly code: number;

	constructor(code: number) {
		super(`exit ${code}`);
		this.code = code;
	}
}

describe("swarm CLI runner", () => {
	it("uses the compatibility command name in missing-argument usage", async () => {
		const errors: unknown[][] = [];

		const result = await runSwarmCli({
			commandName: "omp-swarm",
			argv: ["bun", "src/omp-cli.ts"],
			stderr: { error: (...args: unknown[]) => errors.push(args) },
			exit: code => {
				throw new ExitError(code);
			},
		}).catch((error: unknown) => error);

		expect(result).toBeInstanceOf(ExitError);
		expect((result as ExitError).code).toBe(1);
		expect(errors).toEqual([["Usage: omp-swarm <path-to-yaml>"]]);
	});
});
