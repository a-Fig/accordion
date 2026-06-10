/*
 * telemetry.ts — thin, injectable writers for distill and metrics records (C3 D0).
 *
 * Both functions are fire-and-forget: .catch(()=>{}) silences any error so no
 * distill write ever disrupts the conductor or the live link.
 *
 * Distill record written per tick (one JSONL line in ~/.accordion/distill/<sessionKey>.jsonl):
 *   { at, turn, model, promptVersion, budget, live, entries, decision, usage }
 *
 * Metrics written per unfold-request event in liveClient:
 *   { at, sessionKey, mode, codes, perCode }
 *
 * Tauri-only: in plain browser dev both are no-ops (no accordion_append_line Rust command).
 */

// ── Tauri detection (mirrors gateway.ts) ─────────────────────────────────────
const isTauriEnv =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Fire-and-forget Tauri accordion_append_line call. No-op outside Tauri. */
function appendLine(relPath: string, line: string): void {
	if (!isTauriEnv) return;
	import("@tauri-apps/api/core")
		.then(({ invoke }) => invoke("accordion_append_line", { relPath, line }))
		.catch(() => {});
}

// ── Distill record (one per tick) ─────────────────────────────────────────────

export interface DistillEntry {
	code: string;
	kind: string;
	turn: number;
	tokens: number;
	folded: boolean;
}

export interface DistillRecord {
	at: string;
	turn: number;
	model: string;
	promptVersion: number;
	budget: number;
	live: number;
	entries: DistillEntry[];
	decision: { fold: string[]; unfold: string[] };
	usage: { inTokens: number; outTokens: number };
}

/**
 * Append a distill record to ~/.accordion/distill/<sessionKey>.jsonl.
 * Fire-and-forget; no-op outside Tauri.
 */
export function distillWrite(sessionKey: string, record: DistillRecord): void {
	appendLine(`distill/${sessionKey}.jsonl`, JSON.stringify(record));
}

// ── Metrics record (per agent unfold-request event) ───────────────────────────

export interface MetricsPerCode {
	code: string;
	wasFolded: boolean;
	restored: boolean;
}

export interface MetricsRecord {
	at: string;
	sessionKey: string;
	mode: string;
	codes: string[];
	perCode: MetricsPerCode[];
}

/**
 * Append a metrics record to ~/.accordion/metrics.jsonl.
 * Fire-and-forget; no-op outside Tauri.
 */
export function metricsWrite(record: MetricsRecord): void {
	appendLine("metrics.jsonl", JSON.stringify(record));
}
