import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { linkDevLaunchers, resolveBunGlobalBin } from "./setup-dev";

describe("setup-dev", () => {
	it("resolves the Bun global bin without shelling out to bun pm", () => {
		expect(resolveBunGlobalBin({ OMH_DEV_BIN_DIR: "/tmp/omh-bin", BUN_INSTALL: "/tmp/bun" })).toBe("/tmp/omh-bin");
		expect(resolveBunGlobalBin({ BUN_INSTALL: "/tmp/bun" })).toBe("/tmp/bun/bin");
		expect(resolveBunGlobalBin({ HOME: "/tmp/home" })).toBe("/tmp/home/.bun/bin");
	});

	it("links omh and omp to the source launcher", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omh-setup-dev-"));
		try {
			const launcher = path.join(root, "packages", "coding-agent", "scripts", "omp");
			await Bun.write(launcher, "#!/bin/sh\n");

			const binDir = path.join(root, "bin");
			const linked = await linkDevLaunchers({ repoRoot: root, binDir });

			expect(linked.map(entry => path.basename(entry)).sort()).toEqual(["omh", "omp"]);
			await expect(fs.readlink(path.join(binDir, "omh"))).resolves.toBe(launcher);
			await expect(fs.readlink(path.join(binDir, "omp"))).resolves.toBe(launcher);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
