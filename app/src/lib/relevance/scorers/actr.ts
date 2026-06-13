/*
 * actr.ts — ACT-R base-level activation pure relevance scorer.
 *
 * Anderson & Schooler (1991): B = ln( Σ_j (Δt_j + 1)^(-d) )
 * summed over "reference events" for block b:
 *   1. Creation event at b.turn.
 *   2. Re-mention events: for every later block c whose text contains one of b's
 *      distinctive identifiers, an event at c.turn.
 *
 * "Distinctive" = doc-frequency < 25% of prefix blocks (identCounts).
 *
 * Implementation strategy:
 *   - Build a postings map (ident → block indexes that contain it) ONCE per score().
 *   - Use that map to find re-mention events without O(n²) substring scans.
 *   - Cache extractIdents per Block in a WeakMap (blocks are stable objects).
 *
 * Node-safe, browser-safe. No Svelte, no $lib imports, relative paths only.
 */
import type { Block } from "../../engine/types";
import type { PureScorer, TickContext } from "../types";
import { extractIdents, identCounts } from "../extract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ACT-R decay exponent d. */
export const D = 0.5;

/**
 * Distinctiveness cap: an ident is distinctive for block b only if its
 * document frequency over the prefix is < DISTINCTIVE_DF_CAP * prefixSize.
 */
export const DISTINCTIVE_DF_CAP = 0.25;

/** Exported hyperparameters for ScorerMeta.params. */
export const params: Record<string, unknown> = {
	d: D,
	distinctiveDfCap: DISTINCTIVE_DF_CAP,
};

// ---------------------------------------------------------------------------
// Module-level ident cache (WeakMap so it doesn't pin Blocks in memory)
// ---------------------------------------------------------------------------
const identCache = new WeakMap<Block, string[]>();

function cachedIdents(block: Block): string[] {
	let ids = identCache.get(block);
	if (ids === undefined) {
		ids = extractIdents(block.text);
		identCache.set(block, ids);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// ACT-R activation helper
// ---------------------------------------------------------------------------

/**
 * Compute ACT-R base-level activation given a list of event turns and
 * the current turn.
 *
 * B = ln( Σ_j (Δt_j + 1)^(-d) )
 *
 * where Δt_j = currentTurn - eventTurn_j (≥ 0).
 * +1 prevents division-by-zero when Δt = 0 (same turn).
 * Guards ln(0) by returning -Infinity only if sum is ≤ 0 (shouldn't happen
 * given the +1 offset, but be safe).
 */
function activation(eventTurns: number[], currentTurn: number, d: number): number {
	let sum = 0;
	for (const t of eventTurns) {
		const dt = currentTurn - t;
		// dt should be ≥ 0 by construction; clamp to 0 defensively
		const dtSafe = dt < 0 ? 0 : dt;
		sum += Math.pow(dtSafe + 1, -d);
	}
	if (sum <= 0) return -Infinity;
	return Math.log(sum);
}

// ---------------------------------------------------------------------------
// Scorer implementation
// ---------------------------------------------------------------------------

export const actrScorer: PureScorer = {
	id: "actr",
	version: "1",

	score(ctx: TickContext): (number | null)[] {
		const { blocks, atBlock, endBlock } = ctx;

		if (atBlock === 0) return [];

		// Current turn = turn of the last block in the prefix.
		const currentTurn = blocks[endBlock - 1].turn;

		// Number of blocks in the full prefix (for DF calculation).
		const prefixSize = endBlock;

		// ---------------------------------------------------------------------------
		// 1. Compute document frequencies over the prefix [0, endBlock).
		// ---------------------------------------------------------------------------
		const dfMap = identCounts(blocks, endBlock);

		// ---------------------------------------------------------------------------
		// 2. Build postings map: ident → sorted array of block indexes that contain it,
		//    for indexes in [0, endBlock).
		// ---------------------------------------------------------------------------
		// We build this from scratch to keep it aligned with cachedIdents.
		const postings = new Map<string, number[]>();
		for (let i = 0; i < endBlock; i++) {
			const idents = cachedIdents(blocks[i]);
			for (const id of idents) {
				let list = postings.get(id);
				if (list === undefined) {
					list = [];
					postings.set(id, list);
				}
				list.push(i);
			}
		}

		// Distinctiveness threshold (block count, not fraction).
		const dfThreshold = DISTINCTIVE_DF_CAP * prefixSize;

		// ---------------------------------------------------------------------------
		// 3. Score each block b in [0, atBlock).
		// ---------------------------------------------------------------------------
		const scores: (number | null)[] = new Array(atBlock);

		for (let bi = 0; bi < atBlock; bi++) {
			const b = blocks[bi];

			// Reference events: start with creation event.
			const eventTurns: number[] = [b.turn];

			// Find distinctive identifiers of b.
			const bIdents = cachedIdents(b);
			for (const ident of bIdents) {
				const df = dfMap.get(ident) ?? 0;
				if (df >= dfThreshold) continue; // common ident — not distinctive

				// Distinctive: find all later blocks (order > b.order) that contain this
				// ident, using the postings list (already sorted by index).
				const posting = postings.get(ident);
				if (!posting) continue;

				// posting is in index order. We want indexes > bi (later blocks) and < endBlock.
				// Binary search for the first index > bi.
				let lo = 0;
				let hi = posting.length;
				while (lo < hi) {
					const mid = (lo + hi) >>> 1;
					if (posting[mid] <= bi) lo = mid + 1;
					else hi = mid;
				}
				// All entries from lo onward are > bi and < endBlock (by construction).
				for (let k = lo; k < posting.length; k++) {
					const ci = posting[k];
					// Double-check: only blocks with order > b.order (b.order = bi since
					// blocks are in conversation order; ci > bi guarantees this).
					eventTurns.push(blocks[ci].turn);
				}
			}

			scores[bi] = activation(eventTurns, currentTurn, D);
		}

		return scores;
	},
};
