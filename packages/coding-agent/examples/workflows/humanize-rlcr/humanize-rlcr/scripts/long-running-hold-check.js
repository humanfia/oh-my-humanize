const state = workflowContext.state;
const humanize = state.humanize && typeof state.humanize === "object" ? state.humanize : {};
const operatorGate = humanize.operatorGate && typeof humanize.operatorGate === "object" ? humanize.operatorGate : {};
const startedAtMs = Number.isFinite(operatorGate.recordedAtMs) ? operatorGate.recordedAtMs : Date.now();
const minimumRuntimeMs = Number.isFinite(operatorGate.minimumRuntimeMs) ? operatorGate.minimumRuntimeMs : 8 * 60 * 60 * 1000;
const maximumRuntimeMs = Number.isFinite(operatorGate.maximumRuntimeMs) ? operatorGate.maximumRuntimeMs : 5 * 24 * 60 * 60 * 1000;
const elapsedMs = Math.max(0, Date.now() - startedAtMs);
const longRunningRequested = operatorGate.longRunningRequested === true;
const minimumSatisfied = !longRunningRequested || elapsedMs >= minimumRuntimeMs;
const remainingMinimumMs = Math.max(0, minimumRuntimeMs - elapsedMs);
const runtime = {
	startedAtMs,
	elapsedMs,
	longRunning: {
		requested: longRunningRequested,
		minimumRuntimeMs,
		maximumRuntimeMs,
		minimumSatisfied,
		remainingMinimumMs,
	},
};
const hold = {
	status: minimumSatisfied ? "satisfied" : "pending",
	elapsedMs,
	remainingMinimumMs,
	checkedAtMs: Date.now(),
};
const elapsed = formatDuration(elapsedMs);
const remaining = formatDuration(remainingMinimumMs);
const summary = minimumSatisfied
	? `long-running floor satisfied; elapsed ${elapsed}`
	: `long-running floor pending; elapsed ${elapsed}, remaining ${remaining}`;

return {
	summary,
	statePatch: [
		{ op: "set", path: "/humanize/runtime", value: runtime },
		{ op: "set", path: "/humanize/operatorGate/minimumSatisfied", value: minimumSatisfied },
		{ op: "set", path: "/humanize/longRunningHold", value: hold },
	],
};

function formatDuration(durationMs) {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}
