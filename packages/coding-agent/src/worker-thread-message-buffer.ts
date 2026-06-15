import { parentPort } from "node:worker_threads";

type MessageHandler = (message: unknown) => void;

interface ParkedWorkerThreadMessages {
	pending: unknown[];
	stop(): void;
}

const PARKED_MESSAGES_KEY = Symbol.for("@oh-my-pi/omp.workerThreadEntrypointMessages");

interface WorkerThreadMessageScope {
	[PARKED_MESSAGES_KEY]?: ParkedWorkerThreadMessages;
}

// Bun may deliver the parent's first postMessage before a hidden CLI worker
// finishes dynamically importing its real entrypoint. Park those messages until
// the entrypoint's parentPort listener is installed, then replay them once.
export function parkWorkerThreadEntrypointMessages(): void {
	if (!parentPort) return;
	const port = parentPort;
	const scope = globalThis as WorkerThreadMessageScope;
	if (scope[PARKED_MESSAGES_KEY]) return;

	const pending: unknown[] = [];
	const onMessage = (message: unknown): void => {
		pending.push(message);
	};
	port.on("message", onMessage);

	let active = true;
	scope[PARKED_MESSAGES_KEY] = {
		pending,
		stop() {
			if (!active) return;
			active = false;
			port.off("message", onMessage);
		},
	};
}

export function replayParkedWorkerThreadMessages(handler: MessageHandler): void {
	const scope = globalThis as WorkerThreadMessageScope;
	const parked = scope[PARKED_MESSAGES_KEY];
	if (!parked) return;
	delete scope[PARKED_MESSAGES_KEY];
	parked.stop();
	for (const message of parked.pending.splice(0)) handler(message);
}

export function discardParkedWorkerThreadMessages(): void {
	const scope = globalThis as WorkerThreadMessageScope;
	const parked = scope[PARKED_MESSAGES_KEY];
	if (!parked) return;
	delete scope[PARKED_MESSAGES_KEY];
	parked.stop();
	parked.pending.length = 0;
}
