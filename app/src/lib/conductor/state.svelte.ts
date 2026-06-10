// Conductor — global reactive state for the automatic fold/unfold policy.
// Imported by the UI panel (read) and the tick agent (write via the exported
// helper functions). Keep this dependency-free: no Svelte components, no engine
// imports, no live-link imports.

export type ConductorMode = "off" | "deterministic" | "attentive";

/** The single source of truth for the conductor's runtime state. */
export const conductor = $state({
	mode: "deterministic" as ConductorMode,
	busy: false,         // a tick is in flight
	ticks: 0,            // completed LLM ticks this session
	inTokens: 0,
	outTokens: 0,
	costUSD: 0,          // running cost estimate
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

/** Called by the tick agent when a LLM tick completes. Accumulates counters. */
export function recordTick(usage: {
	inTokens: number;
	outTokens: number;
	costUSD: number;
}): void {
	conductor.ticks += 1;
	conductor.inTokens += usage.inTokens;
	conductor.outTokens += usage.outTokens;
	conductor.costUSD += usage.costUSD;
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
