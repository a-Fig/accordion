/*
 * scheduler.test.ts — tests for the debounce/in-flight logic in scheduler.
 *
 * Because $effect.root is awkward to test in isolation (requires a Svelte runtime
 * with rune support), we test the PURE classes DebounceTimer and InFlightGuard
 * directly — these are the pieces that carry the debounce, single-in-flight, and
 * supersede logic.
 *
 * The integration of those classes into the Svelte effects is covered by the
 * end-to-end tick tests (tick.test.ts) which exercise runTick directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DebounceTimer, InFlightGuard } from "./scheduler.svelte";

// ── DebounceTimer ─────────────────────────────────────────────────────────────

describe("DebounceTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires callback after the delay", () => {
		const timer = new DebounceTimer();
		const fn = vi.fn();
		timer.schedule(fn, 400);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("supersedes pending callback — only the last fires", () => {
		const timer = new DebounceTimer();
		const fn1 = vi.fn();
		const fn2 = vi.fn();
		timer.schedule(fn1, 400);
		vi.advanceTimersByTime(100);
		timer.schedule(fn2, 400); // supersedes fn1
		vi.advanceTimersByTime(400);
		expect(fn1).not.toHaveBeenCalled();
		expect(fn2).toHaveBeenCalledTimes(1);
	});

	it("cancel prevents the callback from firing", () => {
		const timer = new DebounceTimer();
		const fn = vi.fn();
		timer.schedule(fn, 400);
		timer.cancel();
		vi.advanceTimersByTime(500);
		expect(fn).not.toHaveBeenCalled();
	});

	it("pending is true between schedule and fire, false after", () => {
		const timer = new DebounceTimer();
		const fn = vi.fn();
		expect(timer.pending).toBe(false);
		timer.schedule(fn, 400);
		expect(timer.pending).toBe(true);
		vi.advanceTimersByTime(400);
		expect(timer.pending).toBe(false);
	});

	it("can be re-used after firing", () => {
		const timer = new DebounceTimer();
		const fn = vi.fn();
		timer.schedule(fn, 200);
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledTimes(1);
		timer.schedule(fn, 200);
		vi.advanceTimersByTime(200);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

// ── InFlightGuard ─────────────────────────────────────────────────────────────

describe("InFlightGuard", () => {
	it("acquire returns true on first call, false while in-flight", () => {
		const guard = new InFlightGuard();
		expect(guard.acquire()).toBe(true);
		expect(guard.inFlight).toBe(true);
		expect(guard.acquire()).toBe(false); // second acquire fails
	});

	it("release allows a new acquire", () => {
		const guard = new InFlightGuard();
		guard.acquire();
		guard.release();
		expect(guard.inFlight).toBe(false);
		expect(guard.acquire()).toBe(true);
	});

	it("release calls onDirty if set and dirty", () => {
		const guard = new InFlightGuard();
		const onDirty = vi.fn();
		guard.setOnDirty(onDirty);

		guard.acquire(); // in-flight
		guard.acquire(); // sets dirty flag (returns false)
		expect(onDirty).not.toHaveBeenCalled();
		guard.release(); // should call onDirty
		expect(onDirty).toHaveBeenCalledTimes(1);
	});

	it("release does NOT call onDirty if not dirty", () => {
		const guard = new InFlightGuard();
		const onDirty = vi.fn();
		guard.setOnDirty(onDirty);
		guard.acquire();
		guard.release(); // not dirty — no second acquire happened
		expect(onDirty).not.toHaveBeenCalled();
	});

	it("dirty flag is cleared on release so next release does not re-fire onDirty", () => {
		const guard = new InFlightGuard();
		const onDirty = vi.fn();
		guard.setOnDirty(onDirty);

		guard.acquire();
		guard.acquire(); // sets dirty
		guard.release(); // fires onDirty, clears dirty
		expect(onDirty).toHaveBeenCalledTimes(1);

		// Next in-flight cycle without dirty
		guard.acquire();
		guard.release();
		expect(onDirty).toHaveBeenCalledTimes(1); // no additional call
	});

	it("multiple failed acquires only trigger onDirty once", () => {
		const guard = new InFlightGuard();
		const onDirty = vi.fn();
		guard.setOnDirty(onDirty);
		guard.acquire();
		guard.acquire(); // dirty
		guard.acquire(); // already dirty — no change
		guard.acquire(); // already dirty — no change
		guard.release();
		expect(onDirty).toHaveBeenCalledTimes(1);
	});
});
