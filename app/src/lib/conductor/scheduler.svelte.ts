/*
 * scheduler.svelte.ts — debounced tick scheduler for the C3 Attentive Tick.
 *
 * Owns tick triggering. Public surface:
 *   attachConductor(store, opts) → { detach, requestTick }
 *
 * Tick lifecycle:
 *   (a) handle.requestTick("sync") — debounce 400 ms; called by liveClient after each sync
 *   (b) conductor.mode entering "attentive" → immediate tick via $effect
 *   (c) store.budget or store.protectTokens change while attentive → debounce 1000 ms
 *
 * Single-in-flight per instance: if a tick is in-flight, a new request sets a dirty
 * flag and re-runs once after completion. Hard cap MAX_TICKS_PER_SESSION = 300.
 *
 * Ticks run ONLY when conductor.mode === "attentive" && llmAvailable().
 *
 * INSTANCE ISOLATION: attachConductor creates a CLOSURE holding its OWN
 * DebounceTimers, InFlightGuard, tick counter, and $effect.root. No module-level
 * mutable singletons — each call to attachConductor is independent. An in-flight
 * tick from a detached instance no-ops in its .finally rather than mutating the
 * new session's guard or conductor.busy.
 */

import type { AccordionStore } from "../engine/store.svelte";
import { conductor, resetConductorSession } from "./state.svelte";
import { llmAvailable, llmGenerate } from "../llm/gateway";
import { runTick } from "./tick";

export const MAX_TICKS_PER_SESSION = 300;

// ── DebounceTimer — pure, testable ────────────────────────────────────────────

/**
 * Simple one-shot debounce. Exported so tests can import and inject fake timers.
 */
export class DebounceTimer {
	private _tid: ReturnType<typeof setTimeout> | null = null;

	schedule(fn: () => void, delayMs: number): void {
		if (this._tid !== null) clearTimeout(this._tid);
		this._tid = setTimeout(() => {
			this._tid = null;
			fn();
		}, delayMs);
	}

	cancel(): void {
		if (this._tid !== null) {
			clearTimeout(this._tid);
			this._tid = null;
		}
	}

	get pending(): boolean {
		return this._tid !== null;
	}
}

// ── InFlightGuard — pure, testable ────────────────────────────────────────────

/**
 * Tracks in-flight state + "dirty" flag. If a new tick is requested while one
 * is in-flight, the dirty flag is set; the guard calls onDirty() after the
 * current tick finishes so the caller can re-schedule.
 */
export class InFlightGuard {
	private _inFlight = false;
	private _dirty = false;
	private _onDirty: (() => void) | null = null;

	get inFlight(): boolean { return this._inFlight; }

	/** Try to acquire the guard. Returns false if already in-flight (sets dirty). */
	acquire(): boolean {
		if (this._inFlight) {
			this._dirty = true;
			return false;
		}
		this._inFlight = true;
		this._dirty = false;
		return true;
	}

	/** Release and fire onDirty if set while in-flight. */
	release(): void {
		this._inFlight = false;
		const d = this._dirty;
		this._dirty = false;
		if (d && this._onDirty) this._onDirty();
	}

	setOnDirty(fn: () => void): void {
		this._onDirty = fn;
	}
}

// ── ConductorHandle — returned by attachConductor ────────────────────────────

export interface ConductorHandle {
	/** Detach this scheduler instance: dispose effects, cancel timers, mark dead. */
	detach: () => void;
	/**
	 * Schedule a debounced attentive tick (no-op when mode !== "attentive" or
	 * LLM unavailable). Called by liveClient after each sync settles.
	 */
	requestTick: (reason: string) => void;
}

// ── attachConductor ───────────────────────────────────────────────────────────

/**
 * Attach the conductor scheduler to a store. Returns a handle with detach() and
 * requestTick().
 *
 * Each call creates a fresh INSTANCE: its own DebounceTimers, InFlightGuard,
 * tick counter, and $effect.root. No module-level shared state — so attaching
 * a second store (e.g. live after demo) can never pollute the first instance's
 * state, and an in-flight tick from a detached instance no-ops in its .finally.
 *
 * Also resets all per-session conductor counters (ticks, misses, costs, etc.) so
 * counters don't bleed across session boundaries.
 */
export function attachConductor(
	store: AccordionStore,
	opts: { sessionKey: string; live: boolean },
): ConductorHandle {
	// Reset per-session counters on every new attach (session boundary).
	resetConductorSession();

	const sessionKey = opts.sessionKey;
	let tickCount = 0;
	let dead = false;

	const syncDebounce = new DebounceTimer();
	const budgetDebounce = new DebounceTimer();
	const inFlight = new InFlightGuard();

	function _fireTick(): void {
		if (dead) return;
		if (conductor.mode !== "attentive") return;
		if (!llmAvailable()) return;
		if (conductor.tickCapReached) return;
		if (tickCount >= MAX_TICKS_PER_SESSION) {
			conductor.tickCapReached = true;
			conductor.lastError = "tick cap reached";
			return;
		}

		if (!inFlight.acquire()) {
			// In-flight — dirty flag set by acquire(); onDirty will re-run once done
			return;
		}

		conductor.busy = true;
		tickCount++;

		runTick(store, llmGenerate, { sessionKey })
			.catch((err: unknown) => {
				if (!dead) {
					conductor.lastError = err instanceof Error ? err.message : String(err);
				}
			})
			.finally(() => {
				// Only update shared conductor state if this instance is still the active one.
				// A detached instance must never mutate conductor.busy or release the guard
				// in a way that could affect a new session's scheduler.
				if (!dead) {
					conductor.busy = false;
				}
				inFlight.release();
			});
	}

	// When dirty (a new request arrived while in-flight), reschedule via sync debounce
	inFlight.setOnDirty(() => syncDebounce.schedule(_fireTick, 400));

	// $effect.root: watches mode changes and budget/protect changes
	const cleanupEffects = $effect.root(() => {
		// (b) Entering attentive mode → immediate tick
		$effect(() => {
			if (conductor.mode === "attentive") {
				_fireTick();
			}
		});

		// (c) Budget or protectTokens change while attentive → debounce 1000 ms
		$effect(() => {
			// Read both reactive values to subscribe
			void store.budget;
			void store.protectTokens;
			if (conductor.mode === "attentive") {
				budgetDebounce.schedule(_fireTick, 1_000);
			}
		});
	});

	function detach(): void {
		dead = true;
		syncDebounce.cancel();
		budgetDebounce.cancel();
		cleanupEffects();
	}

	function requestTick(_reason: string): void {
		if (dead) return;
		if (conductor.mode !== "attentive") return;
		syncDebounce.schedule(_fireTick, 400);
	}

	return { detach, requestTick };
}
