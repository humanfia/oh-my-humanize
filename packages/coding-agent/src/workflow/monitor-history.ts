import * as path from "node:path";
import { getWorkflowMonitorCacheDir } from "@oh-my-pi/pi-utils";
import { renderWorkflowGraphText, type WorkflowGraphView } from "./graph-view";

export interface WorkflowGraphMonitorSnapshotOptions {
	agentDir?: string;
	now?: Date;
}

export interface WorkflowGraphMonitorSnapshot {
	timestamp: string;
	familyId: string;
	latestFreezeId?: string;
	currentAttemptId?: string;
	view: WorkflowGraphView;
	renderedText: string;
}

export async function writeWorkflowGraphMonitorSnapshot(
	view: WorkflowGraphView,
	options: WorkflowGraphMonitorSnapshotOptions = {},
): Promise<string> {
	const timestamp = (options.now ?? new Date()).toISOString();
	const snapshot: WorkflowGraphMonitorSnapshot = {
		timestamp,
		familyId: view.familyId,
		view,
		renderedText: renderWorkflowGraphText(view),
	};
	if (view.latestFreezeId !== undefined) snapshot.latestFreezeId = view.latestFreezeId;
	if (view.currentAttempt !== undefined) snapshot.currentAttemptId = view.currentAttempt.id;
	const filename = `${sanitizeWorkflowSnapshotSegment(timestamp)}-${sanitizeWorkflowSnapshotSegment(view.familyId)}.json`;
	const snapshotPath = path.join(getWorkflowMonitorCacheDir(options.agentDir), filename);
	await Bun.write(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	return snapshotPath;
}

function sanitizeWorkflowSnapshotSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}
