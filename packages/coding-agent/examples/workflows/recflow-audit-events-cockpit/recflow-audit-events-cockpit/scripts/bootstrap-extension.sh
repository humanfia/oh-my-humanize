#!/bin/sh
set -eu

ROOT=$(pwd)
: "${OMP_WORKFLOW_RESOURCE_DIR:?workflow resource directory is required}"
SOURCE="$OMP_WORKFLOW_RESOURCE_DIR/seed/recflow-lab"
PROJECT="$ROOT/workspace/recflow-lab"
OUT="$ROOT/workflow-output"

rm -rf "$PROJECT"
mkdir -p "$PROJECT" "$OUT"
cp -R "$SOURCE/." "$PROJECT/"

cat > "$PROJECT/test/cli.test.ts" <<'TS'
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as path from "node:path";

const tempRoot = path.resolve(import.meta.dir, "..", ".tmp");

beforeAll(async () => {
	await mkdir(tempRoot, { recursive: true });
});

describe("CLI", () => {
	it("prints recursive runner results as stable JSON", async () => {
		const dir = await mkdtemp(path.join(tempRoot, "recflow-lab-"));
		const planPath = path.join(dir, "plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				kind: "sequence",
				id: "root",
				children: [
					{ kind: "task", id: "start" },
					{ kind: "branch", id: "route", flag: "release", then: { kind: "task", id: "ship" }, else: { kind: "task", id: "hold" } },
				],
			}),
		);

		const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", planPath], {
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr.trim()).toBe("");
		expect(JSON.parse(stdout)).toEqual({ trace: ["start", "ship"], counters: {}, events: [] });
	});
});
TS

cat > "$PROJECT/test/events.test.ts" <<'TS'
import { describe, expect, it } from "bun:test";
import { runPlan } from "../src/engine";
import type { PlanNode } from "../src/types";

describe("execution events", () => {
	it("records recursive enter and exit events with depth and path", async () => {
		const plan: PlanNode = {
			kind: "sequence",
			id: "root",
			children: [
				{ kind: "task", id: "boot" },
				{
					kind: "parallel",
					id: "fanout",
					children: [
						{ kind: "task", id: "engine" },
						{
							kind: "branch",
							id: "choose",
							flag: "release",
							then: { kind: "task", id: "ship" },
							else: { kind: "task", id: "hold" },
						},
					],
				},
			],
		};

		const result = await runPlan(plan, { flags: { release: true }, collectEvents: true });

		expect(result.trace).toEqual(["boot", "engine", "ship"]);
		expect(result.events.map(event => `${event.phase}:${event.id}:${event.depth}:${event.path}`)).toContain(
			"enter:root:0:root",
		);
		expect(result.events.map(event => `${event.phase}:${event.id}:${event.depth}:${event.path}`)).toContain(
			"enter:ship:3:root/fanout[1]/choose/then",
		);
		expect(result.events.at(-1)).toMatchObject({ phase: "exit", id: "root", kind: "sequence", depth: 0 });
	});

	it("records loop iterations in event metadata", async () => {
		const plan: PlanNode = {
			kind: "loop",
			id: "stabilize",
			counter: "round",
			until: 2,
			body: { kind: "task", id: "fix" },
		};

		const result = await runPlan(plan, { collectEvents: true, maxIterations: 5 });
		const fixEnters = result.events.filter(event => event.phase === "enter" && event.id === "fix");

		expect(result.trace).toEqual(["fix", "fix"]);
		expect(fixEnters.map(event => event.iteration)).toEqual([0, 1]);
		expect(fixEnters.map(event => event.path)).toEqual(["stabilize#0", "stabilize#1"]);
	});
});
TS

cat > "$PROJECT/test/cli-events.test.ts" <<'TS'
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as path from "node:path";

const tempRoot = path.resolve(import.meta.dir, "..", ".tmp");

beforeAll(async () => {
	await mkdir(tempRoot, { recursive: true });
});

describe("CLI event output", () => {
	it("prints events when --events is passed", async () => {
		const dir = await mkdtemp(path.join(tempRoot, "recflow-events-"));
		const planPath = path.join(dir, "plan.json");
		await writeFile(
			planPath,
			JSON.stringify({
				kind: "sequence",
				id: "root",
				children: [
					{ kind: "task", id: "start" },
					{ kind: "branch", id: "route", flag: "release", then: { kind: "task", id: "ship" }, else: { kind: "task", id: "hold" } },
				],
			}),
		);

		const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--events", planPath], {
			cwd: path.resolve(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr.trim()).toBe("");
		const parsed = JSON.parse(stdout);
		expect(parsed.trace).toEqual(["start", "ship"]);
		expect(parsed.events.some((event: { phase: string; id: string }) => event.phase === "enter" && event.id === "route")).toBe(true);
	});
});
TS

cat > "$OUT/spec.md" <<'MD'
# Audit Event Extension Contract

The project already implements a recursive runner. This extension adds
inspectable execution events for every node:

- `phase`: `enter` or `exit`.
- `id`: plan node id.
- `kind`: plan node kind.
- `depth`: recursive depth.
- `path`: stable path through sequence, parallel, branch, and loop structure.
- `iteration`: present for loop body events.

The CLI must support `--events <plan.json>` and print stable JSON containing
both `trace` and `events`.
MD

rm -f "$OUT/round.txt" "$OUT/test-status.json" "$OUT/test.log"

printf '%s\n' '{"summary":"bootstrapped audit-event extension with failing TDD tests","statePatch":[{"op":"set","path":"/validation","value":{"status":"bootstrapped","round":0,"summary":"audit event TDD tests created","testLog":"workflow-output/test.log"}}]}'
