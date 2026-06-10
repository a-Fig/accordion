/*
 * tick.ts — pure core of the between-turns LLM conductor (C3 Attentive Tick).
 *
 * Node-safe EXCEPT that it imports AccordionStore type (vitest compiles .svelte.ts;
 * plain-node scripts must NOT import this file directly).
 *
 * Responsibilities:
 *   - buildIndex — summarise all non-protected non-user/tool_call blocks into a
 *     numbered index the LLM can reference by n
 *   - buildTailText — collect the protected-tail text for the "current activity" window
 *   - parseTickDecision — tolerant JSON parser that extracts fold/unfold ops
 *   - applyTickDecision — applies ops through engine guards, then runs refold()
 *   - runTick — end-to-end: build prompt, call LLM, apply, record
 */

import type { AccordionStore } from "../engine/store.svelte";
import type { LlmResponse } from "../llm/types";
import type { LlmRequest } from "../llm/types";
import { foldCode } from "../engine/digest";
import { tickPrompt } from "../llm/prompts";
import { PRICE_IN_PER_M, PRICE_OUT_PER_M } from "../llm/summaryQueue.svelte";
import { recordTick, noteAction } from "./state.svelte";
import { distillWrite } from "./telemetry";

// ── Constants ─────────────────────────────────────────────────────────────────

export const TICK_PROMPT_VERSION = 1;
export const MAX_OPS_PER_SIDE = 8;
export const MAX_INDEX_ENTRIES = 400;
export const TAIL_CHAR_CAP = 24_000;

// ── IndexEntry ────────────────────────────────────────────────────────────────

export interface IndexEntry {
	/** 1-based display number used in the prompt; the model selects by this. */
	n: number;
	id: string;
	code: string;
	kind: string;
	turn: number;
	tokens: number;
	folded: boolean;
	snippet: string;
}

// ── buildIndex ────────────────────────────────────────────────────────────────

/**
 * Build a numbered index of all blocks with index < store.protectedFromIndex,
 * skipping "user" and "tool_call" kinds (never conductor-actionable).
 *
 * If there are more than MAX_INDEX_ENTRIES candidates, we keep the NEWEST ones
 * (highest array index) so the LLM sees the most contextually relevant recent
 * history, and note how many were truncated.
 *
 * snippet: for folded blocks, the digestOf text with the {#...} tag stripped;
 * for live blocks, the raw text — both clipped to 160 chars, single line.
 */
export function buildIndex(store: AccordionStore): { entries: IndexEntry[]; truncatedCount: number } {
	const pf = store.protectedFromIndex;
	const actionableKinds = new Set(["text", "thinking", "tool_result"]);

	// Collect all actionable blocks older than the protected tail
	const candidates: IndexEntry[] = [];
	for (let i = 0; i < pf; i++) {
		const b = store.blocks[i];
		if (!actionableKinds.has(b.kind)) continue;
		const folded = store.isFolded(b);
		let snippet: string;
		if (folded) {
			// Strip the leading {#code FOLDED} tag from the digest
			const d = store.digestOf(b);
			snippet = d.replace(/^\{#\w+ FOLDED\}\s*/, "");
		} else {
			snippet = b.text;
		}
		// Clip to 160 chars, single line
		snippet = snippet.replace(/[\r\n]+/g, " ").slice(0, 160);
		candidates.push({
			n: 0, // assigned below
			id: b.id,
			code: foldCode(b.id),
			kind: b.kind,
			turn: b.turn,
			tokens: b.tokens,
			folded,
			snippet,
		});
	}

	// Truncate: keep the newest MAX_INDEX_ENTRIES (already in order, so take from the end)
	const truncatedCount = Math.max(0, candidates.length - MAX_INDEX_ENTRIES);
	const kept = truncatedCount > 0 ? candidates.slice(truncatedCount) : candidates;

	// Assign 1-based n values
	for (let i = 0; i < kept.length; i++) {
		kept[i].n = i + 1;
	}

	return { entries: kept, truncatedCount };
}

// ── buildTailText ─────────────────────────────────────────────────────────────

/**
 * Concatenate text from the protected tail (from protectedFromIndex to end),
 * then head-truncate to the last TAIL_CHAR_CAP chars so the most recent
 * activity is always present.
 */
export function buildTailText(store: AccordionStore): string {
	const pf = store.protectedFromIndex;
	let text = "";
	for (let i = pf; i < store.blocks.length; i++) {
		text += store.blocks[i].text + "\n";
	}
	if (text.length > TAIL_CHAR_CAP) {
		text = text.slice(text.length - TAIL_CHAR_CAP);
	}
	return text;
}

// ── TickDecision ──────────────────────────────────────────────────────────────

export interface TickDecision {
	fold: { n: number; reason: string }[];
	unfold: { n: number; reason: string }[];
}

// ── parseTickDecision ─────────────────────────────────────────────────────────

/**
 * Tolerant parse of the LLM's JSON response. Strips code fences if present.
 * Invalid or missing arrays default to empty. Arrays are clamped to MAX_OPS_PER_SIDE.
 */
export function parseTickDecision(jsonText: string): TickDecision {
	// Strip code fences (```json ... ``` or ``` ... ```)
	const stripped = jsonText
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		return { fold: [], unfold: [] };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { fold: [], unfold: [] };
	}

	const obj = parsed as Record<string, unknown>;

	function extractOps(arr: unknown): { n: number; reason: string }[] {
		if (!Array.isArray(arr)) return [];
		const out: { n: number; reason: string }[] = [];
		for (const item of arr) {
			if (typeof item !== "object" || item === null) continue;
			const it = item as Record<string, unknown>;
			const n = typeof it.n === "number" ? Math.round(it.n) : NaN;
			if (!isFinite(n) || n < 1) continue;
			const reason = typeof it.reason === "string" ? it.reason.slice(0, 100) : "";
			out.push({ n, reason });
		}
		return out.slice(0, MAX_OPS_PER_SIDE);
	}

	return {
		fold: extractOps(obj.fold),
		unfold: extractOps(obj.unfold),
	};
}

// ── TickResult ────────────────────────────────────────────────────────────────

export interface TickResult {
	skipped?: "empty-index" | "no-actionable";
	folded: { id: string; reason: string }[];
	unfolded: { id: string; reason: string }[];
	rejected: number;
	costUSD: number;
}

// ── applyTickDecision ─────────────────────────────────────────────────────────

/**
 * Apply a tick decision to the store through the engine's own guards.
 *
 * For fold ops: only if entry exists, block is not protected, kind is in
 * {text, thinking, tool_result}, block is not pinned/manually overridden,
 * and not already folded. Then calls store.conductorFold(id) which also
 * enforces its own guards (cooldown, kind, protection, etc.).
 *
 * For unfold ops: only if the block is currently folded. Calls
 * store.conductorUnfold(id, reason).
 *
 * After ALL ops: calls store.refold() ONCE — the deterministic clamp runs last.
 * The LLM proposes; the engine disposes.
 *
 * Also calls noteAction for each applied op.
 */
export function applyTickDecision(
	store: AccordionStore,
	entries: IndexEntry[],
	decision: TickDecision,
): { folded: { id: string; reason: string }[]; unfolded: { id: string; reason: string }[]; rejected: number } {
	const nToEntry = new Map<number, IndexEntry>();
	for (const e of entries) nToEntry.set(e.n, e);

	const folded: { id: string; reason: string }[] = [];
	const unfolded: { id: string; reason: string }[] = [];
	let rejected = 0;

	const actionableKinds = new Set(["text", "thinking", "tool_result"]);

	// Apply fold ops
	for (const op of decision.fold) {
		const entry = nToEntry.get(op.n);
		if (!entry) { rejected++; continue; }

		const b = store.get(entry.id);
		if (!b) { rejected++; continue; }

		// Pre-check guards (mirrors what conductorFold does internally)
		if (store.isProtected(b)) { rejected++; continue; }
		if (!actionableKinds.has(b.kind)) { rejected++; continue; }
		if (b.override !== null) { rejected++; continue; } // pinned or manual override
		if (store.isFolded(b)) { rejected++; continue; } // already folded

		// conductorFold applies its own guards too (cooldown, groupWire, etc.)
		const foldedBefore = store.isFolded(b);
		store.conductorFold(entry.id);
		const foldedAfter = store.isFolded(b);

		if (foldedAfter && !foldedBefore) {
			folded.push({ id: entry.id, reason: op.reason });
			noteAction({ kind: "fold", label: `${entry.kind} · t${entry.turn}`, reason: op.reason });
		} else {
			rejected++;
		}
	}

	// Apply unfold ops
	for (const op of decision.unfold) {
		const entry = nToEntry.get(op.n);
		if (!entry) { rejected++; continue; }

		const b = store.get(entry.id);
		if (!b) { rejected++; continue; }

		if (!store.isFolded(b)) { rejected++; continue; } // not folded — nothing to do

		store.conductorUnfold(entry.id, op.reason);
		unfolded.push({ id: entry.id, reason: op.reason });
		noteAction({ kind: "unfold", label: `${entry.kind} · t${entry.turn}`, reason: op.reason });
	}

	// Deterministic clamp runs LAST — LLM proposes, engine disposes
	store.refold();

	return { folded, unfolded, rejected };
}

// ── runTick ───────────────────────────────────────────────────────────────────

/**
 * End-to-end tick: build index + tail, call LLM, parse decision, apply,
 * record cost, write distill record.
 *
 * @param store - the AccordionStore to read and mutate
 * @param gen - async function that calls the LLM; injected for testability
 * @param opts.write - optional distill/metrics writer (for testing injection)
 * @param opts.sessionKey - session identifier for distill logs
 */
export async function runTick(
	store: AccordionStore,
	gen: (req: LlmRequest) => Promise<LlmResponse>,
	opts?: { write?: (rel: string, line: string) => void; sessionKey?: string },
): Promise<TickResult> {
	const { entries, truncatedCount } = buildIndex(store);

	// Skip if nothing to reason about
	if (entries.length === 0) {
		return { skipped: "empty-index", folded: [], unfolded: [], rejected: 0, costUSD: 0 };
	}

	// Skip if there are no actionable blocks (no folded or unfoldable blocks)
	const hasActionable = entries.some((e) => e.folded || !e.folded);
	// At least one entry exists; but skip if no foldable blocks AND no folded blocks
	// (i.e. nothing can be folded or unfolded)
	const hasFoldable = entries.some((e) => !e.folded);
	const hasFolded = entries.some((e) => e.folded);
	if (!hasFoldable && !hasFolded) {
		return { skipped: "no-actionable", folded: [], unfolded: [], rejected: 0, costUSD: 0 };
	}

	const tailText = buildTailText(store);
	const indexLines = entries.map((e) =>
		`#${e.n} [${e.code}] ${e.kind} t${e.turn} ${e.tokens}tok ${e.folded ? "FOLDED" : "live"} :: ${e.snippet}`,
	);

	const prompt = tickPrompt({
		indexLines,
		tailText,
		liveTokens: store.liveTokens,
		budget: store.budget,
		truncatedCount,
	});

	const req: LlmRequest = {
		role: "tick",
		system: prompt.system,
		user: prompt.user,
		maxOutputTokens: prompt.maxOutputTokens,
		jsonSchema: prompt.jsonSchema,
	};

	let resp: LlmResponse;
	try {
		resp = await gen(req);
	} catch (err) {
		// Import conductor lazily to avoid circular dep issues
		const { conductor } = await import("./state.svelte");
		conductor.lastError = err instanceof Error ? err.message : String(err);
		return { folded: [], unfolded: [], rejected: 0, costUSD: 0 };
	}

	const decision = parseTickDecision(resp.text);
	const { folded, unfolded, rejected } = applyTickDecision(store, entries, decision);

	const costUSD =
		(resp.inTokens * PRICE_IN_PER_M) / 1e6 + (resp.outTokens * PRICE_OUT_PER_M) / 1e6;

	recordTick({ inTokens: resp.inTokens, outTokens: resp.outTokens, costUSD });

	// Write distill record
	const sessionKey = opts?.sessionKey ?? "unknown";
	const distillRecord = {
		at: new Date().toISOString(),
		turn: store.currentTurn,
		model: resp.model,
		promptVersion: TICK_PROMPT_VERSION,
		budget: store.budget,
		live: store.liveTokens,
		entries: entries.map((e) => ({
			code: e.code,
			kind: e.kind,
			turn: e.turn,
			tokens: e.tokens,
			folded: e.folded,
		})),
		decision: {
			fold: folded.map((f) => entries.find((e) => e.id === f.id)?.code ?? ""),
			unfold: unfolded.map((u) => entries.find((e) => e.id === u.id)?.code ?? ""),
		},
		usage: { inTokens: resp.inTokens, outTokens: resp.outTokens },
	};

	if (opts?.write) {
		try {
			opts.write(`distill/${sessionKey}.jsonl`, JSON.stringify(distillRecord));
		} catch {
			// distill write failure is non-fatal
		}
	} else {
		distillWrite(sessionKey, distillRecord);
	}

	return { folded, unfolded, rejected, costUSD };
}
