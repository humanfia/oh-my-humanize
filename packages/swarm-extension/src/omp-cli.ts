#!/usr/bin/env bun
import { runSwarmCli } from "./swarm/cli-runner";

await runSwarmCli({ commandName: "omp-swarm" });
