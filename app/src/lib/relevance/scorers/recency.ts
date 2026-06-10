/*
 * recency.ts — Recency×Kind pure relevance scorer.
 *
 * C1-clamp-shaped baseline: kind prior × exponential turn decay.
 * Node-safe, browser-safe. No Svelte, no $lib imports, relative paths only.
 */
import type { BlockKind } from "../../engine/types";
import type { PureScorer, TickContext } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Half-life in turns: a block loses half its recency score every HALF_LIFE turns. */
export const HALF_LIFE = 20;

/**
 * ln(2) — used to convert half-life into the exponential decay rate.
 * score = prior * exp(-LN2 * turnsSince / HALF_LIFE)
 */
export const LN2 = Math.LN2;

/**
 * Kind-prior weights. Mirrors FOLD_RANK intuition: tool_result decays fastest,
 * user messages retain the most durable value.
 */
export const kindPrior: Record<BlockKind, number> = {
	user: 0.9,
	text: 0.7,
	tool_call: 0.6,
	thinking: 0.45,
	tool_result: 0.3,
};

/**
 * Exported hyperparameters object for ScorerMeta.params stamping.
 */
export const params: Record<string, unknown> = {
	halfLife: HALF_LIFE,
	kindPrior,
};

// ---------------------------------------------------------------------------
// Scorer implementation
// ---------------------------------------------------------------------------

export const recencyScorer: PureScorer = {
	id: "recency",
	version: "1",

	score(ctx: TickContext): (number | null)[] {
		const { blocks, atBlock, endBlock } = ctx;

		// currentTurn = turn of the last block in the prefix (endBlock - 1).
		// endBlock is always >= 1 when atBlock > 0 (context invariant), but guard anyway.
		const currentTurn = endBlock > 0 ? blocks[endBlock - 1].turn : 0;

		const scores: (number | null)[] = new Array(atBlock);
		for (let i = 0; i < atBlock; i++) {
			const b = blocks[i];
			const prior = kindPrior[b.kind] ?? 0.5;
			const turnsSince = currentTurn - b.turn;
			// Exponential half-life decay
			scores[i] = prior * Math.exp(-LN2 * turnsSince / HALF_LIFE);
		}
		return scores;
	},
};
