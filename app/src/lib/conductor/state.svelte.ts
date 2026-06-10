// Conductor — global reactive state for the automatic fold/unfold policy.
// Imported by the UI panel (read) and the tick agent (write via the exported
// helper functions). Keep this dependency-free: no Svelte components, no engine
// imports, no live-link imports.

export type ConductorMode = "off" | "deterministic" | "attentive";

/** The single source of truth for the conductor's runtime state. */
export const conductor = $state({
	mode: "deterministic" as ConductorMode,
	busy: false,         // a tick is in flight
	// ── tick counters (C3 Attentive Tick) ─────────────────────────────────────
	ticks: 0,            // completed LLM ticks this session
	tickInTokens: 0,
	tickOutTokens: 0,
	tickCostUSD: 0,
	// ── summary counters (C2 Summary Queue) ───────────────────────────────────
	summaryCalls: 0,
	summaryInTokens: 0,
	summaryOutTokens: 0,
	summaryCostUSD: 0,
	// ── miss/preempt / agent unfold telemetry ─────────────────────────────────
	misses: 0,           // agent had to ask for a folded block
	preempts: 0,         // conductor/lexical had it open before the agent asked
	lastError: "",
	tickCapReached: false, // set when MAX_TICKS_PER_SESSION is hit
	lastActions: [] as {
		kind: "fold" | "unfold";
		label: string;
		reason: string;
		at: number;
	}[], // newest first, cap 30
});

/** Switch modes and clear any sticky error. */
export function setConductorMode(m: ConductorMode): void {
	conductor.mode = m;
	conductor.lastError = "";
}

/** Called by the tick agent (C3) when an LLM tick completes. Accumulates tick counters only. */
export function recordTick(usage: {
	inTokens: number;
	outTokens: number;
	costUSD: number;
}): void {
	conductor.ticks += 1;
	conductor.tickInTokens += usage.inTokens;
	conductor.tickOutTokens += usage.outTokens;
	conductor.tickCostUSD += usage.costUSD;
}

/** Called by the summary queue (C2) when an LLM summarization completes. Accumulates summary counters only. */
export function recordSummaryCall(usage: {
	inTokens: number;
	outTokens: number;
	costUSD: number;
}): void {
	conductor.summaryCalls += 1;
	conductor.summaryInTokens += usage.inTokens;
	conductor.summaryOutTokens += usage.outTokens;
	conductor.summaryCostUSD += usage.costUSD;
}

/**
 * Reset all per-session counters. Called by attachConductor on every new attach
 * (each attach is a session boundary), so counters don't bleed across sessions.
 */
export function resetConductorSession(): void {
	conductor.ticks = 0;
	conductor.tickInTokens = 0;
	conductor.tickOutTokens = 0;
	conductor.tickCostUSD = 0;
	conductor.summaryCalls = 0;
	conductor.summaryInTokens = 0;
	conductor.summaryOutTokens = 0;
	conductor.summaryCostUSD = 0;
	conductor.misses = 0;
	conductor.preempts = 0;
	conductor.lastError = "";
	conductor.tickCapReached = false;
	conductor.lastActions = [];
}

/** Record a fold or unfold action taken by the conductor. Caps the list at 30. */
export function noteAction(a: {
	kind: "fold" | "unfold";
	label: string;
	reason: string;
}): void {
	conductor.lastActions.unshift({ ...a, at: Date.now() });
	if (conductor.lastActions.length > 30) {
		conductor.lastActions.length = 30;
	}
}
