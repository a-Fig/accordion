/*
 * types.ts — shared vocabulary for the Relevance Lab.
 *
 * Node-safe, browser-safe. No Svelte imports, no `$lib` imports.
 * Relative imports only — same discipline as live/protocol.ts.
 */
import type { Block } from "../engine/types";

export type ScorerId =
	| "recency"
	| "actr"
	| "bm25"
	| "graph"
	| "embed"
	| "judge"
	| "attn"
	| "rerank";

/** Per-scorer metadata recorded alongside scores in a TickScores entry. */
export interface ScorerMeta {
	id: ScorerId;
	version: string;
	/** Wall-clock milliseconds taken to produce these scores. */
	wallMs?: number;
	/** Estimated cost in USD (for API-backed scorers). */
	costUsd?: number;
	/** Scorer-specific hyperparameters used for this run. */
	params?: Record<string, unknown>;
}

/**
 * One evaluation tick — a point in the session where every block strictly older
 * than the protected tail receives a relevance score per scorer.
 *
 * Layout mirrors the score-file schema (v1):
 *  - `blockIds`  ids of the SCORED blocks, i.e. blocks[0..atBlock), in order.
 *  - `scorers`   per-scorer metadata (version, wallMs, costUsd, params).
 *  - `scores`    raw (unnormalized) per-scorer score arrays, each aligned to blockIds.
 */
export interface TickScores {
	/** Ordinal position of this tick within the ScoreFile's ticks array. */
	tick: number;
	/**
	 * Prefix length: scorers see blocks [0, endBlock) ONLY — no future leakage.
	 * Equal to blocks.length at the final tick.
	 */
	endBlock: number;
	/**
	 * Tail boundary within the prefix: blocks [0, atBlock) are scored;
	 * blocks [atBlock, endBlock) form the tail (query context, never scored).
	 */
	atBlock: number;
	/** Ids of scored blocks — blocks[0..atBlock) — in conversation order. */
	blockIds: string[];
	/** Per-scorer metadata, keyed by ScorerId. */
	scorers: Partial<Record<ScorerId, Omit<ScorerMeta, "id">>>;
	/**
	 * Per-scorer raw score arrays, aligned to blockIds.
	 * null entries mean the scorer abstained for that block.
	 */
	scores: Partial<Record<ScorerId, (number | null)[]>>;
}

/** The on-disk score file format (version 1). */
export interface ScoreFile {
	version: 1;
	/** Derived from the session filename (basename without extension). */
	sessionId: string;
	/** ISO-8601 timestamp when the file was generated. */
	generatedAt: string;
	ticks: TickScores[];
}

/**
 * Context passed to every PureScorer for a single evaluation tick.
 *
 * IMPORTANT: `blocks` is the FULL session array. Scorers MUST only read indices
 * `< endBlock` (no future leakage). The scored set is indices [0, atBlock).
 * `tailText` and `tailIdents` are derived from blocks [atBlock, endBlock).
 */
export interface TickContext {
	/**
	 * Full session block array. Scorers must only read indices < endBlock.
	 * Indices [0, atBlock) are the scored set; [atBlock, endBlock) is the tail.
	 */
	blocks: Block[];
	/**
	 * Prefix length — scorers must not read blocks at index >= endBlock.
	 */
	endBlock: number;
	/**
	 * First index of the protected tail within the prefix.
	 * Blocks [0, atBlock) are to be scored; blocks [atBlock, endBlock) are the tail.
	 */
	atBlock: number;
	/**
	 * Concatenated text of tail blocks, joined with "\n\n".
	 * Capped at 60k chars (newest text preserved when truncating).
	 */
	tailText: string;
	/** Identifiers extracted from tailText (lowercase-normalized, deduplicated). */
	tailIdents: string[];
}

/**
 * A pure (no I/O, no external calls) relevance scorer.
 *
 * `score(ctx)` returns an array of length `atBlock`, parallel to the scored
 * block set `blocks.slice(0, atBlock)`. Values are raw (unnormalized) relevance
 * estimates; null means the scorer abstains for that block.
 */
export interface PureScorer {
	id: ScorerId;
	version: string;
	score(ctx: TickContext): (number | null)[];
}
