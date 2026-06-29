import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { captureBaseline, filterPatchByPathPatterns } from "../worktree";

describe("worktree patch capture filters", () => {
	it("keeps only patch sections allowed by the isolation capture contract", () => {
		const patch = [
			"diff --git a/src/main.rs b/src/main.rs",
			"index 1111111..2222222 100644",
			"--- a/src/main.rs",
			"+++ b/src/main.rs",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/target/debug/cache b/target/debug/cache",
			"new file mode 100644",
			"index 0000000..3333333",
			"--- /dev/null",
			"+++ b/target/debug/cache",
			"@@ -0,0 +1 @@",
			"+compiled",
			"diff --git a/workflow-output/report.md b/workflow-output/report.md",
			"new file mode 100644",
			"index 0000000..4444444",
			"--- /dev/null",
			"+++ b/workflow-output/report.md",
			"@@ -0,0 +1 @@",
			"+branch evidence",
			"",
		].join("\n");

		const filtered = filterPatchByPathPatterns(patch, {
			include: ["src/**", "Cargo.toml"],
			exclude: ["target/**", "workflow-output/**"],
		});

		expect(filtered).toContain("diff --git a/src/main.rs b/src/main.rs");
		expect(filtered).not.toContain("target/debug/cache");
		expect(filtered).not.toContain("workflow-output/report.md");
	});

	it("does not materialize excluded untracked files in the baseline patch", async () => {
		using tempDir = TempDir.createSync("@omh-worktree-capture-filter-");
		const cwd = tempDir.path();
		await $`git init`.cwd(cwd).quiet();
		await Bun.write(`${cwd}/src/main.rs`, "fn main() {}\n");
		await $`git add src/main.rs`.cwd(cwd).quiet();
		await $`git -c user.name=OMH -c user.email=omh@example.test commit -m init`.cwd(cwd).quiet();
		await Bun.write(`${cwd}/target/debug/cache`, "compiled\n");
		await Bun.write(`${cwd}/notes.txt`, "candidate note\n");

		const baseline = await captureBaseline(cwd, { exclude: ["target/**"] });

		expect(baseline.root.untrackedPatch).toContain("notes.txt");
		expect(baseline.root.untrackedPatch).not.toContain("target/debug/cache");
	});
});
