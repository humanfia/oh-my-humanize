#!/usr/bin/env bun
import { runSwarmCli } from "./swarm/cli-runner";

await runSwarmCli({ commandName: "omh-swarm" });
