import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const vouchWorkflowPath = path.join(repoRoot, ".github", "workflows", "vouch-pr.yml");
const vouchManageWorkflowPath = path.join(repoRoot, ".github", "workflows", "vouch-manage.yml");
const ciWorkflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

type JsonObject = Record<string, unknown>;

const cleanupDirs: string[] = [];

afterEach(async () => {
	for (const dir of cleanupDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omh-vouch-workflow-"));
	cleanupDirs.push(dir);
	return dir;
}

function asObject(value: unknown, label: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not an object`);
	}
	return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
	return value;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is not a string`);
	return value;
}

function githubExpression(expression: string): string {
	return `$${expression}`;
}

async function parseWorkflow(file: string): Promise<JsonObject> {
	return asObject(Bun.YAML.parse(await Bun.file(file).text()), file);
}

async function workflowStepRun(file: string, stepName: string): Promise<string> {
	const step = await workflowStep(file, stepName);
	return asString(step.run, `${stepName}.run`);
}

async function workflowStep(file: string, stepName: string): Promise<JsonObject> {
	return workflowJobStep(file, "check", stepName);
}

async function workflowJobStep(file: string, jobName: string, stepName: string): Promise<JsonObject> {
	const workflow = await parseWorkflow(file);
	const jobs = asObject(workflow.jobs, "jobs");
	const job = asObject(jobs[jobName], `jobs.${jobName}`);
	const steps = asArray(job.steps, `jobs.${jobName}.steps`);
	for (const step of steps) {
		const obj = asObject(step, "step");
		if (obj.name === stepName || obj.id === stepName) return obj;
	}
	throw new Error(`missing workflow step: ${jobName}.${stepName}`);
}

async function runScript(
	script: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const dir = await makeTempDir();
	const scriptPath = path.join(dir, "script.sh");
	await Bun.write(scriptPath, `set -e\n${script}\n`);
	await fs.chmod(scriptPath, 0o755);
	const proc = Bun.spawn(["bash", scriptPath], {
		cwd: dir,
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function installFakeGh(body: string): Promise<string> {
	const dir = await makeTempDir();
	const gh = path.join(dir, "gh");
	await Bun.write(gh, body);
	await fs.chmod(gh, 0o755);
	return dir;
}

describe("PR vouch workflow", () => {
	it("pins the third-party vouch action while using elevated workflow permissions", async () => {
		const workflow = await parseWorkflow(vouchWorkflowPath);
		const permissions = asObject(workflow.permissions, "permissions");
		expect(permissions.actions).toBe("write");

		const step = await workflowStep(vouchWorkflowPath, "vouch");
		expect(step.uses).toBe("mitchellh/vouch/action/check-pr@f44860978966ace98fb11aaaa20f2b27d7543e13");
	});

	it("pins the discussion-management vouch action while keeping branch write permissions scoped", async () => {
		const workflow = await parseWorkflow(vouchManageWorkflowPath);
		const permissions = asObject(workflow.permissions, "permissions");
		expect(permissions.contents).toBe("write");
		expect(permissions.discussions).toBe("write");

		const step = await workflowJobStep(vouchManageWorkflowPath, "manage", "vouch");
		expect(step.uses).toBe("mitchellh/vouch/action/manage-by-discussion@f44860978966ace98fb11aaaa20f2b27d7543e13");
	});

	it("only treats the vouched label as manual when the labeler has write-level permission", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Detect maintainer-applied vouch label");
		const output = path.join(await makeTempDir(), "output");
		const vouchedFile = Buffer.from("trusted-user\n").toString("base64");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"contents/.github/VOUCHED.td"* ]]; then
  printf '%s\\n' "$FAKE_VOUCHED_CONTENT"
  exit 0
fi
if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then
  printf '%s\\n' "\${FAKE_PERMISSION:-read}"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const triage = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: output,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			LABELER: "triager",
			AUTHOR: "new-user",
			BASE_REF: "main",
			FAKE_VOUCHED_CONTENT: vouchedFile,
			FAKE_PERMISSION: "triage",
		});

		expect(triage.exitCode).toBe(0);
		expect(await Bun.file(output).text()).toContain("status=ignored");

		await Bun.write(output, "");
		const maintainer = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: output,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			LABELER: "maintainer",
			AUTHOR: "new-user",
			BASE_REF: "main",
			FAKE_VOUCHED_CONTENT: vouchedFile,
			FAKE_PERMISSION: "write",
		});

		expect(maintainer.exitCode).toBe(0);
		expect(await Bun.file(output).text()).toContain("status=manual");
	});

	it("does not let manual labels bypass denounced authors", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Detect maintainer-applied vouch label");
		const output = path.join(await makeTempDir(), "output");
		const vouchedFile = Buffer.from("-github:blocked-user policy reason\ntrusted-user\n").toString("base64");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"contents/.github/VOUCHED.td"* ]]; then
  printf '%s\\n' "$FAKE_VOUCHED_CONTENT"
  exit 0
fi
if [[ "$*" == *"/collaborators/"*"/permission"* ]]; then
  printf 'write\\n'
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: output,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			LABELER: "maintainer",
			AUTHOR: "Blocked-User",
			BASE_REF: "main",
			FAKE_VOUCHED_CONTENT: vouchedFile,
		});

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(output).text()).toContain("status=denounced");
	});

	it("detects denounced authors before the upstream PR gate runs", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Detect denounced PR author");
		const output = path.join(await makeTempDir(), "output");
		const vouchedFile = Buffer.from("-github:blocked-user policy reason\ntrusted-user\n").toString("base64");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"contents/.github/VOUCHED.td"* ]]; then
  printf '%s\\n' "$FAKE_VOUCHED_CONTENT"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GITHUB_OUTPUT: output,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			AUTHOR: "Blocked-User",
			BASE_REF: "main",
			FAKE_VOUCHED_CONTENT: vouchedFile,
		});

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(output).text()).toContain("status=denounced");

		const vouchStep = await workflowStep(vouchWorkflowPath, "vouch");
		expect(asString(vouchStep.if, "vouch.if")).toContain("steps.denounced-author.outputs.status != 'denounced'");
		const markStep = await workflowStep(vouchWorkflowPath, "Mark PRs that still need a vouch");
		expect(asString(markStep.if, "mark.if")).toContain("steps.denounced-author.outputs.status == 'denounced'");
	});

	it("treats skipped vouch checks as eligible for review labeling and CI approval", async () => {
		const labelStep = await workflowStep(vouchWorkflowPath, "Label vouched PRs for robomp review");
		const approveStep = await workflowStep(vouchWorkflowPath, "Approve pending PR CI runs");
		expect(asString(labelStep.if, "label.if")).toContain("steps.vouch.outputs.status == 'skipped'");
		expect(asString(approveStep.if, "approve.if")).toContain("steps.vouch.outputs.status == 'skipped'");
	});

	it("polls for the pull_request run and approves it when GitHub creates the run after the gate", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Approve pending PR CI runs");
		const dir = await makeTempDir();
		const counter = path.join(dir, "counter");
		const log = path.join(dir, "gh.log");
		await Bun.write(counter, "0");
		await Bun.write(log, "");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"actions/runs?event=pull_request"* ]]; then
  count="$(cat "$FAKE_GH_COUNTER")"
  next=$((count + 1))
  printf '%s' "$next" > "$FAKE_GH_COUNTER"
  if [[ "$count" == "0" ]]; then
    exit 0
  fi
  printf '123\\twaiting\\n'
  exit 0
fi
if [[ "$*" == *"actions/runs/123/approve"* ]]; then
  printf 'approved\\n' >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			PR: "42",
			HEAD_SHA: "abc123",
			APPROVE_POLL_SECONDS: "3",
			APPROVE_POLL_INTERVAL_SECONDS: "0",
			FAKE_GH_COUNTER: counter,
			FAKE_GH_LOG: log,
		});

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(counter).text()).toBe("2");
		expect(await Bun.file(log).text()).toBe("approved\n");
	});

	it("ignores stale non-waiting CI runs while polling for the current waiting run", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Approve pending PR CI runs");
		const dir = await makeTempDir();
		const counter = path.join(dir, "counter");
		const log = path.join(dir, "gh.log");
		await Bun.write(counter, "0");
		await Bun.write(log, "");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"actions/runs?event=pull_request"* ]]; then
  count="$(cat "$FAKE_GH_COUNTER")"
  next=$((count + 1))
  printf '%s' "$next" > "$FAKE_GH_COUNTER"
  if [[ "$count" == "0" ]]; then
    printf '111\\tcompleted\\n'
    exit 0
  fi
  printf '111\\tcompleted\\n123\\twaiting\\n'
  exit 0
fi
if [[ "$*" == *"actions/runs/123/approve"* ]]; then
  printf 'approved\\n' >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			PR: "42",
			HEAD_SHA: "abc123",
			APPROVE_POLL_SECONDS: "3",
			APPROVE_POLL_INTERVAL_SECONDS: "0",
			FAKE_GH_COUNTER: counter,
			FAKE_GH_LOG: log,
		});

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(counter).text()).toBe("2");
		expect(await Bun.file(log).text()).toBe("approved\n");
	});

	it("only approves CI runs attached to the checked PR number", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Approve pending PR CI runs");
		const log = path.join(await makeTempDir(), "gh.log");
		await Bun.write(log, "");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"actions/runs?event=pull_request"* ]]; then
  if [[ "$*" == *"pull_requests"* && "$*" == *".number == 42"* ]]; then
    printf '222\\twaiting\\n'
  else
    printf '111\\twaiting\\n222\\twaiting\\n'
  fi
  exit 0
fi
if [[ "$*" == *"actions/runs/"*"/approve"* ]]; then
  printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			PR: "42",
			HEAD_SHA: "abc123",
			APPROVE_POLL_SECONDS: "1",
			APPROVE_POLL_INTERVAL_SECONDS: "0",
			FAKE_GH_LOG: log,
		});

		expect(result.exitCode).toBe(0);
		const calls = await Bun.file(log).text();
		expect(calls).toContain("actions/runs/222/approve");
		expect(calls).not.toContain("actions/runs/111/approve");
	});

	it("fails when GitHub rejects approval for a waiting CI run", async () => {
		const script = await workflowStepRun(vouchWorkflowPath, "Approve pending PR CI runs");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"actions/runs?event=pull_request"* ]]; then
  printf '123\\twaiting\\n'
  exit 0
fi
if [[ "$*" == *"actions/runs/123/approve"* ]]; then
  echo "approval denied" >&2
  exit 1
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			PR: "42",
			HEAD_SHA: "abc123",
			APPROVE_POLL_SECONDS: "1",
			APPROVE_POLL_INTERVAL_SECONDS: "0",
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("approval denied");
	});

	it("does not run full CI for arbitrary PR label events", async () => {
		const workflow = await parseWorkflow(ciWorkflowPath);
		const on = asObject(workflow.on, "on");
		const pullRequest = asObject(on.pull_request, "on.pull_request");
		const types = asArray(pullRequest.types, "on.pull_request.types");

		expect(types).toEqual(["opened", "reopened", "synchronize", "ready_for_review"]);
	});

	it("keeps fork main CI off unavailable self-hosted runners", async () => {
		const workflow = await parseWorkflow(ciWorkflowPath);
		const jobs = asObject(workflow.jobs, "jobs");
		const upstreamOnlyRunner = githubExpression(
			"{{ github.event_name != 'pull_request' && github.repository == 'can1357/oh-my-pi' && 'omp-kata' || 'ubuntu-22.04' }}",
		);
		const sharedJobs = [
			"release_metadata",
			"native_artifact_lookup",
			"check",
			"native_linux_x64",
			"test_workspace",
			"test_coding_agent_singleton",
			"test_ts_native",
			"test_coding_agent_ui",
			"test_coding_agent_runtime",
			"test_coding_agent_native",
			"test_smoke",
			"install_methods",
		];

		for (const jobName of sharedJobs) {
			const job = asObject(jobs[jobName], `jobs.${jobName}`);
			expect(asString(job["runs-on"], `${jobName}.runs-on`)).toBe(upstreamOnlyRunner);
		}

		const kataJob = asObject(jobs.native_cross_platform_kata, "jobs.native_cross_platform_kata");
		expect(asString(kataJob["runs-on"], "native_cross_platform_kata.runs-on")).toBe(
			githubExpression("{{ github.repository == 'can1357/oh-my-pi' && matrix.os || 'ubuntu-22.04' }}"),
		);
	});

	it("supports workflow dispatch rechecks after discussion vouches", async () => {
		const workflow = await parseWorkflow(vouchWorkflowPath);
		const on = asObject(workflow.on, "on");
		const dispatch = asObject(on.workflow_dispatch, "on.workflow_dispatch");
		const inputs = asObject(dispatch.inputs, "on.workflow_dispatch.inputs");
		expect(Object.keys(inputs).sort()).toEqual(["author_login", "head_sha", "pr_number"]);

		const step = await workflowStep(vouchWorkflowPath, "vouch");
		expect(asString(step.if, "vouch.if")).toContain("github.event_name == 'workflow_dispatch'");
	});

	it("discussion vouches retrigger the PR gate for matching open PRs", async () => {
		const script = await workflowJobStep(
			vouchManageWorkflowPath,
			"manage",
			"Recheck open PRs for vouched authors",
		).then(step => asString(step.run, "recheck.run"));
		const log = path.join(await makeTempDir(), "gh.log");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == pr\\ list* ]]; then
  printf '11\\tabc123\\n12\\tdef456\\n'
  exit 0
fi
if [[ "$*" == workflow\\ run* ]]; then
  printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			COMMENT_BODY: "!vouch @new-user reason",
			DISCUSSION_AUTHOR: "discussion-owner",
			FAKE_GH_LOG: log,
		});

		expect(result.exitCode).toBe(0);
		const calls = await Bun.file(log).text();
		expect(calls).toContain("vouch-pr.yml");
		expect(calls).toContain("-f pr_number=11");
		expect(calls).toContain("-f head_sha=abc123");
		expect(calls).toContain("-f author_login=new-user");
		expect(calls).toContain("-f pr_number=12");
	});

	it("discussion denounces retrigger the PR gate for matching open PRs", async () => {
		const script = await workflowJobStep(
			vouchManageWorkflowPath,
			"manage",
			"Recheck open PRs for vouched authors",
		).then(step => asString(step.run, "recheck.run"));
		const log = path.join(await makeTempDir(), "gh.log");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == pr\\ list* ]]; then
  printf '13\\tbad123\\n'
  exit 0
fi
if [[ "$*" == workflow\\ run* ]]; then
  printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		const result = await runScript(script, {
			PATH: `${ghDir}:${process.env.PATH ?? ""}`,
			GH_TOKEN: "token",
			REPO: "humanfia/oh-my-humanize",
			COMMENT_BODY: "!denounce @bad-user policy reason",
			DISCUSSION_AUTHOR: "discussion-owner",
			FAKE_GH_LOG: log,
		});

		expect(result.exitCode).toBe(0);
		const calls = await Bun.file(log).text();
		expect(calls).toContain("vouch-pr.yml");
		expect(calls).toContain("-f pr_number=13");
		expect(calls).toContain("-f head_sha=bad123");
		expect(calls).toContain("-f author_login=bad-user");
	});

	it("discussion vouch rechecks allow whitespace and case-insensitive keywords", async () => {
		const script = await workflowJobStep(
			vouchManageWorkflowPath,
			"manage",
			"Recheck open PRs for vouched authors",
		).then(step => asString(step.run, "recheck.run"));
		const log = path.join(await makeTempDir(), "gh.log");
		const ghDir = await installFakeGh(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == pr\\ list* ]]; then
  printf '11\\tabc123\\n'
  exit 0
fi
if [[ "$*" == workflow\\ run* ]]; then
  printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
  exit 0
fi
echo "unexpected gh: $*" >&2
exit 2
`);

		for (const body of ["  !vouch @new-user reason", "!VOUCH @new-user reason"]) {
			await Bun.write(log, "");
			const result = await runScript(script, {
				PATH: `${ghDir}:${process.env.PATH ?? ""}`,
				GH_TOKEN: "token",
				REPO: "humanfia/oh-my-humanize",
				COMMENT_BODY: body,
				DISCUSSION_AUTHOR: "discussion-owner",
				FAKE_GH_LOG: log,
			});

			expect(result.exitCode).toBe(0);
			const calls = await Bun.file(log).text();
			expect(calls).toContain("-f author_login=new-user");
		}
	});
});
