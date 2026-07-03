import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "./dag";
import { PipelineController } from "./pipeline";
import { renderSwarmProgress } from "./render";
import { parseSwarmYaml, validateSwarmDefinition } from "./schema";
import { StateTracker } from "./state";

export interface SwarmCliOptions {
	commandName: "omh-swarm" | "omp-swarm";
	argv?: readonly string[];
	stderr?: Pick<typeof console, "error">;
	exit?: (code: number) => never;
}

const PROGRESS_INTERVAL_MS = 5000;

export async function runSwarmCli(options: SwarmCliOptions): Promise<void> {
	const argv = options.argv ?? process.argv;
	const stderr = options.stderr ?? console;
	const exit = options.exit ?? process.exit;
	const yamlPath = argv[2];
	if (!yamlPath) {
		stderr.error(`Usage: ${options.commandName} <path-to-yaml>`);
		exit(1);
	}

	const resolvedPath = path.resolve(yamlPath);
	console.log(`Reading: ${resolvedPath}`);

	const content = await Bun.file(resolvedPath).text();
	const def = parseSwarmYaml(content);

	console.log(`Swarm: ${def.name}`);
	console.log(`Mode: ${def.mode}`);
	console.log(`Target count: ${def.targetCount}`);
	console.log(`Agents: ${[...def.agents.keys()].join(", ")}`);

	const errors = validateSwarmDefinition(def);
	if (errors.length > 0) {
		stderr.error("Validation errors:", errors);
		exit(1);
	}

	const deps = buildDependencyGraph(def);
	const cycles = detectCycles(deps);
	if (cycles) {
		stderr.error("Cycle detected:", cycles);
		exit(1);
	}
	const waves = buildExecutionWaves(deps);
	console.log(`Waves: ${waves.map((w, i) => `W${i + 1}:[${w.join(",")}]`).join(" -> ")}`);

	const workspace = path.isAbsolute(def.workspace)
		? def.workspace
		: path.resolve(path.dirname(resolvedPath), def.workspace);

	await fs.mkdir(workspace, { recursive: true });
	console.log(`Workspace: ${workspace}`);

	const stateTracker = new StateTracker(workspace, def.name);
	await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();

	let lastProgressDump = 0;

	console.log("\n--- Pipeline starting ---\n");

	const controller = new PipelineController(def, waves, stateTracker);
	const result = await controller.run({
		workspace,
		onProgress: () => {
			const now = Date.now();
			if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
				lastProgressDump = now;
				const lines = renderSwarmProgress(stateTracker.state);
				console.log(lines.join("\n"));
				console.log();
			}
		},
		modelRegistry,
		settings,
	});

	console.log("\n--- Pipeline finished ---\n");
	console.log(`Status: ${result.status}`);
	console.log(`Iterations completed: ${result.iterations}/${def.targetCount}`);
	if (result.errors.length > 0) {
		console.log(`Errors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.log(`  - ${err}`);
		}
	}
	console.log(`\nState saved to: ${stateTracker.swarmDir}`);

	const lines = renderSwarmProgress(stateTracker.state);
	console.log(lines.join("\n"));
}
