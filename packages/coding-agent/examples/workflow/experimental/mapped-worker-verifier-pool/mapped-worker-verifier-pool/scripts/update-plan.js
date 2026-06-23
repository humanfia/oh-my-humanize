function main() {
	const state = context.state;
	const mapped = context.activation.mapped;

	if (!mapped) {
		// Initial seed node.
		return {
			statePatch: [
				{ op: "set", path: "/plan", value: { tasks: ["task-1", "task-2", "task-3", "task-4", "task-5"] } },
				{ op: "set", path: "/pool/queue", value: [
					{ id: "task-1" },
					{ id: "task-2" },
					{ id: "task-3" },
					{ id: "task-4" },
					{ id: "task-5" },
				] },
				{ op: "set", path: "/pool/done", value: false },
				{ op: "set", path: "/pool/results", value: {} },
			],
		};
	}

	// Reducer for a mapped pool item.
	const itemKey = mapped.itemKey;
	const result = state.pool?.results?.[itemKey];
	const patch = [];

	// Append task-6 if task-1 requested expansion.
	if (result?.expand === true || result?.verdict === "expand") {
		const queue = Array.isArray(state.pool?.queue) ? [...state.pool.queue] : [];
		if (!queue.some(item => item?.id === "task-6")) {
			queue.push({ id: "task-6" });
		}
		patch.push({ op: "set", path: "/pool/queue", value: queue });
	}

	// Mark done when all known tasks have results.
	const knownTasks = state.plan?.tasks ?? [];
	const allCompleted = knownTasks.every(task => state.pool?.results?.[task] !== undefined);
	if (allCompleted && state.pool?.done === false) {
		patch.push({ op: "set", path: "/pool/done", value: true });
	}

	return { statePatch: patch };
}

return main();
