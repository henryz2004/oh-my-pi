/**
 * Watch for an rpc-ui launcher exiting without stdin reaching EOF.
 *
 * The original parent PID identifies the process that owns the protocol pipes.
 * If it exits while another process holds stdin open, EOF cannot trigger normal
 * shutdown. A changed parent PID lets rpc-ui request that shutdown explicitly.
 * A process started directly under PID 1 has no launcher to watch.
 */
export interface ParentWatchOptions {
	/** The parent PID recorded at start (`process.ppid` then). */
	originalPpid: number;
	/** Called once, when the parent changes. */
	onReparented: (from: number, to: number) => void;
	/** Live parent PID; defaults to `process.ppid`. */
	getPpid?: () => number;
	/** Poll interval; capped at 5000 ms. */
	pollMs?: number;
}

export const PARENT_WATCH_MAX_POLL_MS = 5000;

/** Start watching; returns a stop function. A no-op when there is no real parent to watch. */
export function watchParentReparent(options: ParentWatchOptions): () => void {
	const { originalPpid, onReparented } = options;
	if (!Number.isInteger(originalPpid) || originalPpid <= 1) return () => {};
	const getPpid = options.getPpid ?? (() => process.ppid);
	const pollMs = Math.max(1, Math.min(options.pollMs ?? PARENT_WATCH_MAX_POLL_MS, PARENT_WATCH_MAX_POLL_MS));
	let fired = false;
	const timer = setInterval(() => {
		if (fired) return;
		const current = getPpid();
		if (current === originalPpid) return;
		fired = true;
		clearInterval(timer);
		onReparented(originalPpid, current);
	}, pollMs);
	// Never keep the process alive on its own account.
	(timer as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}
