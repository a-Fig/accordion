/*
 * bm25.ts — BM25 (identifier-space) pure relevance scorer.
 *
 * Query = ctx.tailIdents (extracted from tail).
 * Document = multiset of identifiers in block text (per-occurrence count).
 * IDF over prefix [0, endBlock). avgdl over prefix.
 *
 * Node-safe, browser-safe. No Svelte, no $lib imports, relative paths only.
 */
import type { Block } from "../../engine/types";
import type { PureScorer, TickContext } from "../types";
import { extractIdents, identCounts } from "../extract";

// ---------------------------------------------------------------------------
// Hyperparameters
// ---------------------------------------------------------------------------

export const params = {
	k1: 1.2,
	b: 0.75,
};

// ---------------------------------------------------------------------------
// Per-block ident cache
// ---------------------------------------------------------------------------

/**
 * Cache the ident SET (deduplicated, lowercase) for each stable Block object.
 * Scorers are called repeatedly on the same block objects — avoid re-extracting.
 */
const blockIdentCache = new WeakMap<Block, string[]>();

function blockIdents(block: Block): string[] {
	let cached = blockIdentCache.get(block);
	if (!cached) {
		cached = extractIdents(block.text);
		blockIdentCache.set(block, cached);
	}
	return cached;
}

// ---------------------------------------------------------------------------
// Term-frequency helper
// ---------------------------------------------------------------------------

/**
 * Count non-overlapping occurrences of `term` in `text` using split.
 * Both `text` and `term` are expected to already be lowercased.
 */
// CAVEAT(L5): split-based count matches `term` as a substring, so an ident like "foo" also counts inside "foobar"; consistent across all blocks, so relative ranking is roughly preserved.
function countOccurrences(text: string, term: string): number {
	if (!term) return 0;
	return text.split(term).length - 1;
}

// ---------------------------------------------------------------------------
// Scorer implementation
// ---------------------------------------------------------------------------

export const bm25Scorer: PureScorer = {
	id: "bm25",
	version: "1",

	score(ctx: TickContext): (number | null)[] {
		const { blocks, atBlock, endBlock, tailIdents } = ctx;

		// No query terms → all scores are 0.
		if (!tailIdents.length) {
			return new Array(atBlock).fill(0);
		}

		const N = endBlock; // corpus size (prefix length)

		// --- IDF: document-frequency over prefix [0, endBlock) ---
		const dfMap = identCounts(blocks, endBlock);

		function idf(term: string): number {
			const df = dfMap.get(term) ?? 0;
			return Math.log(1 + (N - df + 0.5) / (df + 0.5));
		}

		// --- avgdl: average total ident occurrences per block in prefix ---
		let totalDocLen = 0;
		for (let i = 0; i < endBlock; i++) {
			const b = blocks[i];
			const lc = b.text.toLowerCase();
			const idents = blockIdents(b);
			let dl = 0;
			for (const ident of idents) {
				dl += countOccurrences(lc, ident);
			}
			totalDocLen += dl;
		}
		const avgdl = N > 0 ? totalDocLen / N : 1;

		// --- BM25 score for each block in [0, atBlock) ---
		const { k1, b } = params;
		const scores: (number | null)[] = new Array(atBlock);

		for (let i = 0; i < atBlock; i++) {
			const block = blocks[i];
			const lc = block.text.toLowerCase();
			const idents = blockIdents(block);

			// Only score if any tail ident appears in this block's ident set.
			const identSet = new Set(idents);
			const queryTerms = tailIdents.filter((t) => identSet.has(t));

			if (!queryTerms.length) {
				scores[i] = 0;
				continue;
			}

			// doc length = total ident occurrences in block text
			let dl = 0;
			for (const ident of idents) {
				dl += countOccurrences(lc, ident);
			}

			let score = 0;
			for (const term of queryTerms) {
				const tf = countOccurrences(lc, term);
				if (tf === 0) continue;
				const termIdf = idf(term);
				// BM25 TF saturation
				const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / (avgdl || 1))));
				score += termIdf * tfNorm;
			}

			scores[i] = score;
		}

		return scores;
	},
};
