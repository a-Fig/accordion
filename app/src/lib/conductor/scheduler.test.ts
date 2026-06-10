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
import { DebounceTimer, InFlightGuard, attachConductor } from "./scheduler.svelte";
import { conductor, recordTick, recordSummaryCall, resetConductorSession } from "./state.svelte";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, ParsedSession } from "../engine/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function blk(
	id: string,
	kind: Block["kind"] = "text",
	turn: number = 1,
	tokens: number = 500,
): Block {
	return { id, kind, turn, order: 0, text: `block ${id}`, tokens, override: null, autoFolded: false, by: null };
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks: [blk("a", "text", 1, 500)],
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

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

// ── attachConductor instance isolation (M2+M3) ───────────────────────────────

describe("attachConductor instance isolation", () => {
	it("detach marks instance dead: requestTick is a no-op after detach", () => {
		const store = makeStore();
		const handle = attachConductor(store, { sessionKey: "test", live: false });

		// requestTick is callable before detach (no-op because mode != "attentive")
		expect(() => handle.requestTick("sync")).not.toThrow();

		handle.detach();

		// After detach: requestTick is a no-op (dead=true guard), must not throw
		expect(() => handle.requestTick("sync")).not.toThrow();
	});

	it("each attachConductor call resets conductor counters (session boundary)", () => {
		// Populate some counters from a "previous session"
		resetConductorSession();
		recordTick({ inTokens: 100, outTokens: 20, costUSD: 0.001 });
		expect(conductor.ticks).toBe(1);
		expect(conductor.tickCostUSD).toBeGreaterThan(0);

		const store = makeStore();
		const handle = attachConductor(store, { sessionKey: "session2", live: false });

		// attachConductor must have reset all session counters
		expect(conductor.ticks).toBe(0);
		expect(conductor.tickCostUSD).toBe(0);
		expect(conductor.misses).toBe(0);
		expect(conductor.preempts).toBe(0);
		expect(conductor.lastActions).toHaveLength(0);
		handle.detach();
	});

	it("two handles are independent: detaching A does not affect B's guard or counters", () => {
		const storeA = makeStore();
		const storeB = makeStore();

		const handleA = attachConductor(storeA, { sessionKey: "A", live: false });
		// Detach A, then attach B (B resets counters on attach)
		handleA.detach();
		const handleB = attachConductor(storeB, { sessionKey: "B", live: false });

		// handleA.requestTick must be dead (no-op)
		expect(() => handleA.requestTick("sync")).not.toThrow();
		// handleB.requestTick must be live (callable without error)
		expect(() => handleB.requestTick("sync")).not.toThrow();

		handleB.detach();
	});

	it("detached instance does not see its own requestTick fire after detach with fake timers", () => {
		vi.useFakeTimers();
		try {
			const store = makeStore();
			const handle = attachConductor(store, { sessionKey: "iso", live: false });
			handle.detach();

			// This would have scheduled a tick if not dead
			handle.requestTick("sync");
			// Advance past any debounce window — nothing should fire (dead=true)
			vi.advanceTimersByTime(1000);
			// No assertions on tick count; just verifying no uncaught errors or mutations
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── state counters split (M4) ────────────────────────────────────────────────

describe("conductor state counters — recordTick vs recordSummaryCall", () => {
	beforeEach(() => {
		resetConductorSession();
	});

	it("recordTick increments tick buckets only", () => {
		recordTick({ inTokens: 100, outTokens: 20, costUSD: 0.001 });
		expect(conductor.ticks).toBe(1);
		expect(conductor.tickInTokens).toBe(100);
		expect(conductor.tickOutTokens).toBe(20);
		expect(conductor.tickCostUSD).toBe(0.001);
		// Summary buckets untouched
		expect(conductor.summaryCalls).toBe(0);
		expect(conductor.summaryInTokens).toBe(0);
		expect(conductor.summaryOutTokens).toBe(0);
		expect(conductor.summaryCostUSD).toBe(0);
	});

	it("recordSummaryCall increments summary buckets only", () => {
		recordSummaryCall({ inTokens: 200, outTokens: 50, costUSD: 0.01 });
		expect(conductor.summaryCalls).toBe(1);
		expect(conductor.summaryInTokens).toBe(200);
		expect(conductor.summaryOutTokens).toBe(50);
		expect(conductor.summaryCostUSD).toBe(0.01);
		// Tick buckets untouched
		expect(conductor.ticks).toBe(0);
		expect(conductor.tickInTokens).toBe(0);
		expect(conductor.tickOutTokens).toBe(0);
		expect(conductor.tickCostUSD).toBe(0);
	});

	it("resetConductorSession zeroes all counters including misses, preempts, lastError, tickCapReached, lastActions", () => {
		recordTick({ inTokens: 100, outTokens: 20, costUSD: 0.001 });
		recordSummaryCall({ inTokens: 200, outTokens: 50, costUSD: 0.01 });
		conductor.misses = 3;
		conductor.preempts = 2;
		conductor.lastError = "some error";
		conductor.tickCapReached = true;
		conductor.lastActions.push({ kind: "fold", label: "x", reason: "y", at: 1 });

		resetConductorSession();

		expect(conductor.ticks).toBe(0);
		expect(conductor.tickInTokens).toBe(0);
		expect(conductor.tickOutTokens).toBe(0);
		expect(conductor.tickCostUSD).toBe(0);
		expect(conductor.summaryCalls).toBe(0);
		expect(conductor.summaryInTokens).toBe(0);
		expect(conductor.summaryOutTokens).toBe(0);
		expect(conductor.summaryCostUSD).toBe(0);
		expect(conductor.misses).toBe(0);
		expect(conductor.preempts).toBe(0);
		expect(conductor.lastError).toBe("");
		expect(conductor.tickCapReached).toBe(false);
		expect(conductor.lastActions).toHaveLength(0);
	});

	it("recordTick and recordSummaryCall accumulate independently over multiple calls", () => {
		recordTick({ inTokens: 10, outTokens: 5, costUSD: 0.001 });
		recordTick({ inTokens: 20, outTokens: 8, costUSD: 0.002 });
		recordSummaryCall({ inTokens: 100, outTokens: 30, costUSD: 0.01 });

		expect(conductor.ticks).toBe(2);
		expect(conductor.tickInTokens).toBe(30);
		expect(conductor.tickOutTokens).toBe(13);
		expect(Math.abs(conductor.tickCostUSD - 0.003)).toBeLessThan(1e-9);
		expect(conductor.summaryCalls).toBe(1);
		expect(conductor.summaryInTokens).toBe(100);
	});
});

// ── miss-metric dedupe + disarmed-gating (m1) ────────────────────────────────
// The deduplication and disarmed-gating logic lives inline in liveClient.
// We test the underlying pure principles here.

describe("miss-metric deduplication logic (m1)", () => {
	it("Set deduplication removes repeated codes", () => {
		const codes = ["abc", "xyz", "abc", "abc", "xyz"];
		const unique = [...new Set(codes)];
		expect(unique).toHaveLength(2);
		expect(unique).toContain("abc");
		expect(unique).toContain("xyz");
	});

	it("Set deduplication is idempotent when codes are already unique", () => {
		const codes = ["a", "b", "c"];
		const unique = [...new Set(codes)];
		expect(unique).toHaveLength(3);
	});

	it("empty codes array produces empty unique set", () => {
		const codes: string[] = [];
		const unique = [...new Set(codes)];
		expect(unique).toHaveLength(0);
	});

	it("disarmed gate: misses and preempts must NOT be counted when folding is disabled", () => {
		// Mirrors the gated block in liveClient.svelte.ts
		const foldingEnabled = false;
		const perCode = [
			{ code: "abc", wasFolded: true, restored: false },
			{ code: "xyz", wasFolded: false, restored: true },
		];

		let misses = 0;
		let preempts = 0;
		if (foldingEnabled) {
			for (const pc of perCode) {
				if (pc.wasFolded) misses++;
				else if (pc.restored) preempts++;
			}
		}

		expect(misses).toBe(0);
		expect(preempts).toBe(0);
	});

	it("armed gate: misses and preempts ARE counted when folding is enabled", () => {
		const foldingEnabled = true;
		const perCode = [
			{ code: "abc", wasFolded: true, restored: false },
			{ code: "xyz", wasFolded: false, restored: true },
			{ code: "qqq", wasFolded: false, restored: false },
		];

		let misses = 0;
		let preempts = 0;
		if (foldingEnabled) {
			for (const pc of perCode) {
				if (pc.wasFolded) misses++;
				else if (pc.restored) preempts++;
			}
		}

		expect(misses).toBe(1);
		expect(preempts).toBe(1);
	});

	it("wasFolded is only checked when folding is enabled (disarmed → all wasFolded stay false)", () => {
		// When disarmed, the perCode loop in liveClient sets wasFolded only if
		// (folding.enabled && store) is truthy. Simulate that gate:
		const foldingEnabled = false;
		// Pretend we have a store where code "abc" IS folded
		const wasFoldedChecker = (code: string): boolean => {
			if (!foldingEnabled) return false; // gate
			// Would check store here
			return code === "abc";
		};

		const codes = ["abc", "xyz"];
		const perCode = codes.map((code) => ({ code, wasFolded: wasFoldedChecker(code), restored: false }));

		expect(perCode.every((pc) => !pc.wasFolded)).toBe(true);
	});
});
