/*
 * summaryQueue.svelte.ts — LLM summarize-ahead pipeline (C2).
 *
 * Attaches to an AccordionStore and continuously fills the summary cache
 * by generating LLM summaries for eligible folded/old blocks. All work is
 * fire-and-forget; nothing here blocks a model call or the UI.
 *
 * Webview only: calls accordion_read_text / accordion_append_line (Rust) and
 * llmGenerate (Tauri). No-ops silently in plain browser dev.
 *
 * Pricing constants: gemini-2.5-flash-lite list prices at time of C2 ship.
 */

import type { Block } from "../engine/types";
import type { AccordionStore } from "../engine/store.svelte";
import { FOLDABLE_KINDS } from "../engine/digest";
import { summaryKey, parseCacheLines, serializeEntry, SummaryCacheMem } from "../engine/summaryCache";
import type { CacheEntry } from "../engine/summaryCache";
import { llmAvailable, llmGenerate } from "./gateway";
import { summaryPrompt, PROMPT_VERSION } from "./prompts";
import { conductor } from "../conductor/state.svelte";
import { recordSummaryCall } from "../conductor/state.svelte";
import { LlmError } from "./types";

// ── Pricing (gemini-2.5-flash-lite list prices, USD per 1M tokens) ────────────
/** Input token price per 1M tokens — gemini-2.5-flash-lite list price. */
export const PRICE_IN_PER_M = 0.10;
/** Output token price per 1M tokens — gemini-2.5-flash-lite list price. */
export const PRICE_OUT_PER_M = 0.40;

// ── Module-level disk cache (loaded once per app run) ────────────────────────
const CACHE_PATH = "summaries/cache.jsonl";
let _cachePromise: Promise<SummaryCacheMem> | null = null;

function loadDiskCache(): Promise<SummaryCacheMem> {
	if (_cachePromise) return _cachePromise;
	_cachePromise = (async () => {
		const mem = new SummaryCacheMem();
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const text = await invoke<string>("accordion_read_text", { relPath: CACHE_PATH });
			mem.load(parseCacheLines(text));
		} catch {
			// Tauri not available, or file doesn't exist yet — start with empty cache.
		}
		return mem;
	})();
	return _cachePromise;
}

// ── Hard caps ────────────────────────────────────────────────────────────────
const MAX_CALLS_PER_SESSION = 400;
const MAX_INFLIGHT = 2;
const MIN_TOKENS_FOR_SUMMARY = 300;
const POLL_INTERVAL_MS = 1500;

// ── Pure exported helpers (for unit testing) ─────────────────────────────────

/**
 * Returns the subset of a store's blocks that are eligible candidates for
 * LLM summarization: old (< protectedFromIndex), foldable kind, large enough,
 * no summary yet, not in the provided sets of cached-keys, in-flight ids, or
 * failed ids.
 *
 * `keyMemo` is a mutable Map<blockId, key> that the caller maintains across
 * calls — keys are computed once per block and reused (hashing is async, so
 * synchronous candidates use the memoized result only). Blocks with no memoized
 * key yet are SKIPPED (keys must be pre-populated by the async prepare step).
 */
export function selectCandidates(
	store: AccordionStore,
	keyMemo: Map<string, string>,
	cache: SummaryCacheMem,
	inFlight: Set<string>,
	failed: Set<string>,
): Block[] {
	const pf = store.protectedFromIndex;
	const candidates: Block[] = [];
	for (let i = 0; i < pf; i++) {
		const b = store.blocks[i];
		if (!FOLDABLE_KINDS.has(b.kind)) continue;
		if (b.tokens < MIN_TOKENS_FOR_SUMMARY) continue;
		if (store.hasSummary(b.id)) continue;
		if (inFlight.has(b.id)) continue;
		if (failed.has(b.id)) continue;
		const key = keyMemo.get(b.id);
		if (!key) continue; // key not computed yet — skip until next cycle
		if (cache.get(key)) continue; // already in disk cache
		candidates.push(b);
	}
	return candidates;
}

/**
 * Sort candidates: currently-folded first (improve live context immediately),
 * then largest-first within each tier.
 */
export function prioritizeCandidates(store: AccordionStore, candidates: Block[]): Block[] {
	return [...candidates].sort((a, b) => {
		const aFolded = store.isFolded(a) ? 1 : 0;
		const bFolded = store.isFolded(b) ? 1 : 0;
		if (bFolded !== aFolded) return bFolded - aFolded; // folded first
		return b.tokens - a.tokens; // largest first
	});
}

// ── Queue attachment ──────────────────────────────────────────────────────────

/**
 * Attach the summarize-ahead queue to a store. Call once per store instance;
 * returns a detach function to call when the store is replaced.
 *
 * Internally starts a setInterval at 1500ms. Each cycle:
 *   1. Ensures keys are memoized for all current candidates (async, lazy).
 *   2. Applies any cached-but-not-yet-applied summaries to the store.
 *   3. If conditions are met, picks up to 2 blocks and generates summaries.
 *
 * Never runs while document.hidden — pauses to avoid burning quota in
 * background windows.
 */
export function attachSummaryQueue(store: AccordionStore): () => void {
	const keyMemo = new Map<string, string>(); // blockId → cache key
	const inFlight = new Set<string>(); // blockIds currently being generated
	const failed = new Set<string>(); // blockIds that failed this session
	let callsThisSession = 0;
	let dead = false; // set on quota error — stop queue permanently for this store
	let cacheRef: SummaryCacheMem | null = null;

	// Load disk cache asynchronously; once resolved we hold a reference.
	loadDiskCache().then((c) => { cacheRef = c; });

	// Asynchronously compute+memoize keys for blocks that don't have one yet.
	// Runs in the background; the sync candidate selection skips blocks without keys.
	async function prepareKeys(): Promise<void> {
		if (!cacheRef) return;
		const pf = store.protectedFromIndex;
		for (let i = 0; i < pf; i++) {
			const b = store.blocks[i];
			if (!FOLDABLE_KINDS.has(b.kind)) continue;
			if (b.tokens < MIN_TOKENS_FOR_SUMMARY) continue;
			if (keyMemo.has(b.id)) continue; // already computed
			// model is fixed: gemini-2.5-flash-lite (the summary model)
			const key = await summaryKey({
				text: b.text,
				kind: b.kind,
				promptVersion: PROMPT_VERSION,
				model: "gemini-2.5-flash-lite",
			});
			keyMemo.set(b.id, key);
		}
	}

	// Apply any cached summaries that haven't been pushed to the store yet.
	function applyCachedSummaries(): void {
		if (!cacheRef) return;
		const pf = store.protectedFromIndex;
		for (let i = 0; i < pf; i++) {
			const b = store.blocks[i];
			if (store.hasSummary(b.id)) continue;
			const key = keyMemo.get(b.id);
			if (!key) continue;
			const entry = cacheRef.get(key);
			if (entry) {
				store.setSummary(b.id, entry.summary);
			}
		}
	}

	// Generate a summary for a single block.
	async function generateOne(b: Block, cache: SummaryCacheMem): Promise<void> {
		if (inFlight.has(b.id)) return;
		inFlight.add(b.id);
		try {
			const kind = b.kind as "text" | "thinking" | "tool_result";
			const p = summaryPrompt(kind, b.text, b.toolName ?? undefined);
			const resp = await llmGenerate({ role: "summary", system: p.system, user: p.user, maxOutputTokens: p.maxOutputTokens });
			const summary = resp.text.trim();

			// Reject empty or absurdly long summaries (> 4× the target max output tokens)
			if (!summary || summary.length > p.maxOutputTokens * 4 * 4) {
				// 4× tokens × ~4 chars/token
				failed.add(b.id);
				console.warn(`[summaryQueue] rejected summary for ${b.id}: empty or too long`);
				return;
			}

			const key = keyMemo.get(b.id)!;
			const entry: CacheEntry = {
				key,
				summary,
				kind,
				model: resp.model,
				promptVersion: PROMPT_VERSION,
				srcTokens: b.tokens,
				sumTokens: Math.ceil(summary.length / 4),
				at: Date.now(),
			};

			// Persist to disk (non-fatal on error).
			try {
				const { invoke } = await import("@tauri-apps/api/core");
				await invoke("accordion_append_line", { relPath: CACHE_PATH, line: serializeEntry(entry) });
			} catch {
				// Disk write failed — still apply in-memory.
			}

			cache.put(entry);
			store.setSummary(b.id, summary);
			recordSummaryCall({
				inTokens: resp.inTokens,
				outTokens: resp.outTokens,
				costUSD: resp.inTokens * PRICE_IN_PER_M / 1e6 + resp.outTokens * PRICE_OUT_PER_M / 1e6,
			});
		} catch (err) {
			if (err instanceof LlmError && err.kind === "quota") {
				// Quota exhausted — stop the queue permanently for this store.
				dead = true;
				conductor.lastError = `Summary queue quota exhausted: ${err.message}`;
				console.warn("[summaryQueue] quota exceeded — queue stopped for this store");
			} else {
				failed.add(b.id);
				console.warn(`[summaryQueue] generation failed for ${b.id}:`, err);
			}
		} finally {
			inFlight.delete(b.id);
		}
	}

	// Main tick — runs every POLL_INTERVAL_MS.
	async function tick(): Promise<void> {
		if (dead) return;
		if (typeof document !== "undefined" && document.hidden) return; // paused in background
		if (!cacheRef) return; // cache not loaded yet

		// Kick off key preparation in the background (next tick will benefit).
		prepareKeys().catch(() => {});

		// Apply any newly computable cached summaries.
		applyCachedSummaries();

		// Determine whether to generate new summaries.
		const shouldGenerate =
			llmAvailable() &&
			conductor.mode !== "off" &&
			(store.liveTokens > 0.5 * store.budget || store.foldedCount > 0);

		if (!shouldGenerate) return;
		if (callsThisSession >= MAX_CALLS_PER_SESSION) return;
		if (inFlight.size >= MAX_INFLIGHT) return;

		const rawCandidates = selectCandidates(store, keyMemo, cacheRef, inFlight, failed);
		const sorted = prioritizeCandidates(store, rawCandidates);

		const slots = MAX_INFLIGHT - inFlight.size;
		const picked = sorted.slice(0, Math.min(slots, 2));

		for (const b of picked) {
			if (callsThisSession >= MAX_CALLS_PER_SESSION) break;
			callsThisSession++;
			generateOne(b, cacheRef).catch(() => {}); // fire-and-forget
		}
	}

	const interval = setInterval(() => { tick().catch(() => {}); }, POLL_INTERVAL_MS);

	return function detach() {
		clearInterval(interval);
	};
}
