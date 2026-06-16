let taskText = "";
try {
	taskText = await Bun.file("task.md").text();
} catch {
	taskText = "";
}

const taskContract = taskText.trim();
if (!taskContract) {
	throw new Error("parallel-implementation-review requires a task.md contract in the project root");
}

return {
	summary: "parallel implementation task contract recorded from task.md",
	statePatch: [{ op: "set", path: "/taskContract", value: taskContract.slice(0, 8000) }],
};
