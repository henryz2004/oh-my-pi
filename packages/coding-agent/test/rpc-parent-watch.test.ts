import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PARENT_WATCH_MAX_POLL_MS, watchParentReparent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-parent-watch";

const WATCH_MODULE = path.resolve(import.meta.dir, "../src/modes/rpc/rpc-parent-watch.ts");

describe("watchParentReparent (unit, fake clock)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("no watcher when there is no real parent to watch", () => {
		vi.useFakeTimers();
		let calls = 0;
		const stop = watchParentReparent({
			originalPpid: 1,
			getPpid: () => 999,
			onReparented: () => calls++,
			pollMs: 10,
		});
		vi.advanceTimersByTime(60_000);
		stop();
		expect(calls).toBe(0);
	});

	test("fires once on a changed parent, never while the parent is unchanged", () => {
		vi.useFakeTimers();
		let ppid = 4242;
		const seen: Array<[number, number]> = [];
		const stop = watchParentReparent({
			originalPpid: 4242,
			getPpid: () => ppid,
			pollMs: 10,
			onReparented: (a, b) => seen.push([a, b]),
		});
		vi.advanceTimersByTime(10_000);
		expect(seen).toEqual([]);
		ppid = 1;
		vi.advanceTimersByTime(10);
		vi.advanceTimersByTime(10_000);
		expect(seen).toEqual([[4242, 1]]);
		stop();
	});

	test("the poll interval is capped at 5 s even when a longer one is asked", () => {
		vi.useFakeTimers();
		let ppid = 4242;
		let calls = 0;
		const stop = watchParentReparent({
			originalPpid: 4242,
			getPpid: () => ppid,
			pollMs: 60_000,
			onReparented: () => calls++,
		});
		ppid = 1;
		vi.advanceTimersByTime(PARENT_WATCH_MAX_POLL_MS);
		expect(calls).toBe(1);
		stop();
	});
});

// Real process tree. Deterministic time control does not apply here: the property under test
// is that a real child observes the kernel reparenting it after its real parent is SIGKILLed,
// so the child polls process.ppid on the platform clock. Waits poll for the observable
// outcome (a marker file, the pid gone) with a bounded deadline rather than a fixed sleep.
async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(25);
	}
	return check();
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("watchParentReparent (real process tree)", () => {
	let dir = "";
	const pids: number[] = [];

	afterEach(() => {
		for (const pid of pids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	async function startTree(): Promise<{ parent: number; child: number; armed: string; exited: string }> {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-parent-watch-"));
		const armed = path.join(dir, "armed");
		const exited = path.join(dir, "exited");
		const childFile = path.join(dir, "child.ts");
		// Mimics an orphan-prone rpc-ui process: its stdin pipe is never closed by anyone (no EOF
		// path), it stays alive on its own, and it exits only through the watcher's callback.
		fs.writeFileSync(
			childFile,
			`import * as fs from "node:fs";
import { watchParentReparent } from ${JSON.stringify(WATCH_MODULE)};
watchParentReparent({ originalPpid: process.ppid, pollMs: 50, onReparented: (from, to) => {
  fs.writeFileSync(${JSON.stringify(exited)}, JSON.stringify({ from, to }));
  process.exit(0);
} });
fs.writeFileSync(${JSON.stringify(armed)}, String(process.ppid));
setInterval(() => {}, 1 << 30);
`,
		);
		const parentFile = path.join(dir, "parent.ts");
		fs.writeFileSync(
			parentFile,
			`const child = Bun.spawn([process.execPath, ${JSON.stringify(childFile)}], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
console.log(child.pid);
setInterval(() => {}, 1 << 30);
`,
		);
		const parent = Bun.spawn([process.execPath, parentFile], { stdout: "pipe", stderr: "inherit" });
		pids.push(parent.pid);
		const reader = parent.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		const child = Number.parseInt(new TextDecoder().decode(value).trim(), 10);
		pids.push(child);
		expect(await until(() => fs.existsSync(armed), 10_000)).toBe(true);
		return { parent: parent.pid, child, armed, exited };
	}

	test("killing the launcher makes the child exit through the callback", async () => {
		const { parent, child, armed, exited } = await startTree();
		expect(Number(fs.readFileSync(armed, "utf8"))).toBe(parent);
		process.kill(parent, "SIGKILL");
		expect(await until(() => fs.existsSync(exited), 5000)).toBe(true);
		expect(await until(() => !alive(child), 5000)).toBe(true);
		const record = JSON.parse(fs.readFileSync(exited, "utf8")) as { from: number; to: number };
		expect(record.from).toBe(parent);
		expect(record.to).not.toBe(parent);
	});

	test("a live launcher never triggers the exit", async () => {
		const { child, exited } = await startTree();
		// The negative case needs a window in which the child has polled several times (50 ms
		// interval); there is no event that proves "did not fire", so this one wait is real.
		await Bun.sleep(400);
		expect(alive(child)).toBe(true);
		expect(fs.existsSync(exited)).toBe(false);
	});
});
