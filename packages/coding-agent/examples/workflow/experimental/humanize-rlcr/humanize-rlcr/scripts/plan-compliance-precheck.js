const task = await readTaskContract();
const taskText = task.text;

const trimmedTask = taskText.trim();
const branchSwitchingRequested =
	/\b(?:switch|checkout|change)\s+(?:to\s+)?(?:branch|worktree)\b|\bgit\s+checkout\b|\bbase\s+branch\s*:\s*(?!main\b)[^\n]+/iu.test(
		trimmedTask,
	);
const status =
	trimmedTask.length === 0
		? "operator-contract-required"
		: branchSwitchingRequested
			? "needs-operator-confirmation"
			: "ready-for-human-gate";
const precheck = {
	status,
	taskSource: trimmedTask.length === 0 ? "operator prompt" : task.source,
	branchSwitchingRequested,
	taskPreview: trimmedTask.slice(0, 1200),
	checkedAtMs: Date.now(),
};

return {
	summary: `task contract precheck recorded: ${status}`,
	statePatch: [
		{
			op: "set",
			path: "/humanize",
			value: { precheck },
		},
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
