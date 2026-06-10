/*
 * scheduler.svelte.ts — debounced tick scheduler for the C3 Attentive Tick.
 *
 * Owns tick triggering. Exported public surface:
 *   attachConductor(store, opts) → detach fn
 *   requestTick(reason)          → called by liveClient after each sync
 *
 * Tick lifecycle:
 *   (a) requestTick("sync") — debounce 400 ms; called by liveClient after each sync
 *   (b) conductor.mode entering "attentive" → immediate tick via $effect
 *   (c) store.budget or store.protectTokens change while attentive → debounce 1000 ms
 *
 * Single-in-flight: if a tick is in-flight, a new request sets a dirty flag and
 * re-runs once after completion. Hard cap MAX_TICKS_PER_SESSION = 300.
 *
 * Ticks run ONLY when conductor.mode === "attentive" && llmAvailable().
 */

import type { AccordionStore } from "../engine/store.svelte";
import { conductor } from "./state.svelte";
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

// ── Module-level scheduler state ──────────────────────────────────────────────
// Only one scheduler is active at a time (one active store).

let _store: AccordionStore | null = null;
let _sessionKey = "unknown";
let _tickCount = 0;
let _syncDebounce = new DebounceTimer();
let _budgetDebounce = new DebounceTimer();
let _inFlight = new InFlightGuard();

function _fireTick(): void {
	if (!_store) return;
	if (conductor.mode !== "attentive") return;
	if (!llmAvailable()) return;
	if (conductor.tickCapReached) return;
	if (_tickCount >= MAX_TICKS_PER_SESSION) {
		conductor.tickCapReached = true;
		conductor.lastError = "tick cap reached";
		return;
	}

	if (!_inFlight.acquire()) {
		// In-flight — dirty flag set by acquire(); onDirty will re-run once done
		return;
	}

	conductor.busy = true;
	_tickCount++;

	const store = _store;
	const sessionKey = _sessionKey;

	runTick(store, llmGenerate, { sessionKey })
		.catch((err: unknown) => {
			conductor.lastError = err instanceof Error ? err.message : String(err);
		})
		.finally(() => {
			conductor.busy = false;
			_inFlight.release();
		});
}

/**
 * Called by liveClient after each sync settles. Schedules a debounced tick.
 */
export function requestTick(_reason: string): void {
	if (conductor.mode !== "attentive") return;
	_syncDebounce.schedule(_fireTick, 400);
}

/**
 * Attach the conductor scheduler to a store. Returns a detach function.
 *
 * Uses $effect.root for reactive watchers; the returned function cleans up
 * both the root effect and any pending timers.
 */
export function attachConductor(
	store: AccordionStore,
	opts: { sessionKey: string; live: boolean },
): () => void {
	// Reset session-local counters
	_store = store;
	_sessionKey = opts.sessionKey;
	_tickCount = 0;
	_syncDebounce = new DebounceTimer();
	_budgetDebounce = new DebounceTimer();
	_inFlight = new InFlightGuard();

	// When dirty (a new request arrived while in-flight), reschedule via sync debounce
	_inFlight.setOnDirty(() => _syncDebounce.schedule(_fireTick, 400));

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
				_budgetDebounce.schedule(_fireTick, 1_000);
			}
		});
	});

	return function detach() {
		_store = null;
		_syncDebounce.cancel();
		_budgetDebounce.cancel();
		cleanupEffects();
	};
}
