const state = workflowContext.state;
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const task = await readTaskContract();
const taskText = task.text;

const immutableGoal = taskText.trim().slice(0, 4000) || "Follow the operator-provided task brief and acceptance criteria.";
const ledger = {
	currentRound: 0,
	archivedRoundCount: 0,
	retainedRoundLimit: 6,
	oldestRetainedRound: 0,
	latestRetainedRound: 0,
	rounds: [],
	openIssues: [],
	queuedIssues: [],
	advisoryIssues: [],
	blockers: [],
	stagnation: {
		status: "none",
		sameFindingCount: 0,
	},
};

const goal = {
	immutableGoal,
	round: 0,
	acceptance: {
		source: taskText ? task.source : "operator prompt",
		status: "open",
	},
	ledger,
	precheck: humanize.precheck ?? {},
};

return {
	summary: "goal tracker initialized with durable RLCR ledger",
	statePatch: [
		{ op: "set", path: "/humanize/goal", value: goal },
		{ op: "set", path: "/humanize/ledger", value: ledger },
	],
};

async function readTaskContract() {
	for (const source of ["task.md", "TASK.md"]) {
		try {
			return { source, text: await Bun.file(source).text() };
		} catch {}
	}
	return { source: "operator prompt", text: "" };
}
