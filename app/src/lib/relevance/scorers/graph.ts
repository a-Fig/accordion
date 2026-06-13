/*
 * graph.ts — Spreading-activation graph scorer.
 *
 * Entities = "distinctive" identifiers: df < 25% of prefix blocks AND df >= 2.
 * Implicit bipartite graph: block ↔ ident postings.
 * Seeds: tail blocks [atBlock, endBlock), each with activation 1.0.
 * Propagate 2 hops with per-hop decay 0.5.
 * Fan-out cap: skip idents whose posting list is longer than 50 blocks.
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
	hops: 2,
	decay: 0.5,
	dfCapRatio: 0.25,
	fanoutCap: 50,
};

// ---------------------------------------------------------------------------
// Per-block ident cache (shared pattern with bm25.ts)
// ---------------------------------------------------------------------------

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
// Scorer implementation
// ---------------------------------------------------------------------------

export const graphScorer: PureScorer = {
	id: "graph",
	version: "1",

	score(ctx: TickContext): (number | null)[] {
		const { blocks, atBlock, endBlock } = ctx;

		const prefixLen = endBlock;
		const scores = new Float64Array(atBlock); // initialised to 0

		if (atBlock === 0 || endBlock <= atBlock) {
			return Array.from(scores) as number[];
		}

		// --- 1. Compute df over prefix [0, endBlock) ---
		const dfMap = identCounts(blocks, endBlock);

		const { dfCapRatio, fanoutCap } = params;
		const dfThreshold = dfCapRatio * prefixLen; // must be STRICTLY less than this

		// --- 2. Build ident → blockIndexes postings for DISTINCTIVE idents only ---
		//   Distinctive: df >= 2 AND df < dfThreshold
		const postings = new Map<string, number[]>(); // ident → [blockIndex, ...]

		for (let i = 0; i < endBlock; i++) {
			const idents = blockIdents(blocks[i]);
			for (const ident of idents) {
				const df = dfMap.get(ident) ?? 0;
				if (df < 2 || df >= dfThreshold) continue;
				let list = postings.get(ident);
				if (!list) {
					list = [];
					postings.set(ident, list);
				}
				list.push(i);
			}
		}

		// --- 3. Compute idf-ish weight per ident: 1/log2(1+df) ---
		function identWeight(ident: string): number {
			const df = dfMap.get(ident) ?? 1;
			return 1 / Math.log2(1 + df);
		}

		// --- 4. Seed activation from tail blocks [atBlock, endBlock) ---
		// activation[i] = cumulative activation received by block i
		const hop1 = new Float64Array(endBlock); // indexed 0..endBlock-1
		const hop2 = new Float64Array(endBlock);

		const { decay } = params;

		// Hop 1: seeds → scored blocks
		for (let si = atBlock; si < endBlock; si++) {
			const seedIdents = blockIdents(blocks[si]);
			for (const ident of seedIdents) {
				const posting = postings.get(ident);
				if (!posting) continue;
				if (posting.length > fanoutCap) continue; // hub → skip
				const weight = identWeight(ident);
				const contribution = decay * weight; // 1.0 * decay * weight
				for (const bi of posting) {
					if (bi === si) continue; // no self-loop
					hop1[bi] += contribution;
				}
			}
		}

		// Hop 2: hop-1 recipients → further scored blocks
		// "A block never propagates back through the same ident edge it received from
		//  — keep it simple: just exclude self."
		for (let hi = 0; hi < atBlock; hi++) {
			const mass = hop1[hi];
			if (mass === 0) continue;
			const hopIdents = blockIdents(blocks[hi]);
			for (const ident of hopIdents) {
				const posting = postings.get(ident);
				if (!posting) continue;
				if (posting.length > fanoutCap) continue;
				const weight = identWeight(ident);
				const contribution = mass * decay * weight;
				for (const bi of posting) {
					if (bi === hi) continue; // no self-loop
					hop2[bi] += contribution;
				}
			}
		}

		// --- 5. Combine: final score = hop1 + hop2 for scored blocks [0, atBlock) ---
		for (let i = 0; i < atBlock; i++) {
			scores[i] = hop1[i] + hop2[i];
		}

		return Array.from(scores) as number[];
	},
};
