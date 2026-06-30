const humanActivation = [...workflowContext.completedActivations]
	.reverse()
	.find(activation => activation.nodeId === "collectIdeaInput");
const output = humanActivation?.output && typeof humanActivation.output === "object" ? humanActivation.output : {};
const data = output.data && typeof output.data === "object" ? output.data : {};
const response = typeof data.response === "string" ? data.response : typeof output.summary === "string" ? output.summary : "";
const argsText = response.trim();

if (!argsText || /^Decision:\s*(?:proceed|stop|hold)\b/iu.test(argsText)) {
	throw new Error(
		'Missing gen-idea arguments. Restart the workflow and use the Ask dialog\'s `Other` / custom input field, or create `.humanize/gen-idea.args` with e.g. `"add undo/redo" --n 4`.',
	);
}

return {
	summary: "recorded interactive gen-idea arguments",
	statePatch: [
		{
			op: "set",
			path: "/ideaArgs",
			value: {
				status: "loaded",
				source: "human",
				argsText,
			},
		},
	],
};
