import * as path from "node:path";

const state = workflowContext.state && typeof workflowContext.state === "object" ? workflowContext.state : {};
const taskContract = state.taskContract ?? {};
const plan = state.plan ?? {};
const candidate = state.candidate ?? {};
const humanizeHandoff = state.finalizeSummary ?? {};
const validationActivations = workflowContext.completedActivations.filter(
	activation => activation.nodeId === "validateCandidate",
);
const latestValidation = validationActivations.at(-1)?.output ?? {};
const promotionVerdict =
	latestValidation && typeof latestValidation === "object" && "verdict" in latestValidation
		? latestValidation.verdict
		: "unknown";
const evidence = {
	status: "recorded",
	taskContract,
	plan,
	humanizeHandoff,
	candidate,
	validationVerdict: promotionVerdict,
	validationActivationCount: validationActivations.length,
	recordedAtMs: Date.now(),
};
const outputDir = path.join(process.cwd(), "workflow-output");
await Bun.write(
	path.join(outputDir, "kda-evidence.md"),
	[
		"# KDA Evidence",
		"",
		"## Task Contract",
		"",
		"```json",
		JSON.stringify(taskContract, null, 2),
		"```",
		"",
		"## Plan",
		"",
		"```json",
		JSON.stringify(plan, null, 2),
		"```",
		"",
		"## Nested Humanize Handoff",
		"",
		"```json",
		JSON.stringify(humanizeHandoff, null, 2),
		"```",
		"",
		"## Candidate",
		"",
		"```json",
		JSON.stringify(candidate, null, 2),
		"```",
		"",
		"## Validation",
		"",
		`- Verdict: ${String(promotionVerdict)}`,
		`- Validation activations: ${validationActivations.length}`,
		"",
	].join("\n"),
);

return {
	summary: "recorded KDA evidence from task contract, plan, nested Humanize handoff, candidate, and validation verdict",
	statePatch: [{ op: "set", path: "/evidence", value: evidence }],
	artifacts: ["local://workflow-output/kda-evidence.md"],
};
