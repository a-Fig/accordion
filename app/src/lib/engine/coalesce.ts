/*
 * coalesce.ts — auto-coalesce policy for the conductor pipeline (ADR 0009, C2.5).
 *
 * Pure, Node-safe policy: no Svelte, no `$state`, no side effects.
 *
 * Identifies "runs" of long-cold, contiguous, already-auto-folded blocks (older than
 * the protected tail, not in any group, not on cooldown, not crossed by user messages)
 * and returns the slice boundaries that should be collapsed into flat conductor-built
 * groups. The store wires the results to createGroup().
 *
 * This module NEVER folds anything itself — it only reports WHERE to coalesce blocks
 * that are ALREADY auto-folded. Net savings = stub consolidation only.
 */

import type { Block, Group } from "./types";

/** Tunable constants — one object keeps all knobs in one place. */
export const COALESCE_CONFIG = {
	/** Minimum contiguous auto-folded members required to form a group. */
	minRun: 8,
	/** A run's newest block must be at least this many turns older than currentTurn. */
	minAgeTurns: 20,
	/** Maximum members per group (blast-radius cap). */
	maxMembers: 12,
	/** Maximum sum of full tokens per group (blast-radius cap). */
	maxFullTokens: 15_000,
	/** Turns after a conductor group is dissolved before it may re-form (group hysteresis). */
	cooldownTurns: 8,
} as const;

/** A candidate group to coalesce — startId/endId are INCLUSIVE member boundaries. */
export interface CoalesceRun {
	startId: string;
	endId: string;
	memberCount: number;
}

export interface FindCoalesceInput {
	blocks: Block[];
	/** Only scan indices [0, protectedFromIndex). */
	protectedFromIndex: number;
	/** Highest turn in the session — used for age check. */
	currentTurn: number;
	/** True if a block id is already in any group (skip these). */
	inGroup: (id: string) => boolean;
	/**
	 * True if a block is "auto-folded" as far as the coalescer is concerned:
	 * `override === null && autoFolded === true` (any pin, manual override, or
	 * agent-sticky unfold breaks the run).
	 */
	isAutoFolded: (b: Block) => boolean;
	/** True if the first-member id of a run is under group hysteresis cooldown. */
	groupCoolActive: (firstId: string) => boolean;
}

/**
 * Scan [0, protectedFromIndex) for maximal eligible runs, then chunk them to respect
 * maxMembers and maxFullTokens. Returns only chunks with memberCount >= minRun that
 * are not under group hysteresis cooldown.
 *
 * Eligibility rules for a block inside a run:
 *  - block index < protectedFromIndex
 *  - NOT a "user" kind (user blocks are the natural seams — they split runs)
 *  - for text/thinking/tool_result: isAutoFolded(b) must be true
 *  - tool_call blocks are ALLOWED inside a run ONLY if their callId partner (the
 *    matching tool_result) is ALSO inside the same run; an orphaned tool_call breaks
 *    the run (splitting a call/result pair across a group boundary would straggler-leak)
 *  - block turn <= currentTurn - minAgeTurns
 *  - NOT already in a group
 *  - NOT under individual cooldown
 */
export function findCoalesceRuns(input: FindCoalesceInput): CoalesceRun[] {
	const { blocks, protectedFromIndex, currentTurn, inGroup, isAutoFolded, groupCoolActive } = input;
	const ageCutoff = currentTurn - COALESCE_CONFIG.minAgeTurns;
	const limit = Math.min(protectedFromIndex, blocks.length);

	// All tool_call callIds in the SESSION — distinguishes a tool_result whose call
	// exists elsewhere (must never be separated from it: inside a folded group it
	// would become a FULL-cost straggler, turning a ~20-token stub into a token
	// spike) from a result with no call at all (compaction etc. — safe alone).
	const sessionCallIds = new Set<string>();
	for (const b of blocks) {
		if (b.kind === "tool_call" && b.callId) sessionCallIds.add(b.callId);
	}

	// ── Pass 1: collect maximal contiguous eligible spans ──────────────────────
	// We first collect candidate blocks (not yet checking tool-pair integrity across
	// the span) and split at user-kind, non-auto-folded, or already-grouped boundaries.
	const maximalRuns: Block[][] = [];
	let current: Block[] = [];

	const flush = () => {
		if (current.length > 0) {
			maximalRuns.push(current);
			current = [];
		}
	};

	for (let i = 0; i < limit; i++) {
		const b = blocks[i];

		// User blocks are seams — never coalesced, always split runs
		if (b.kind === "user") {
			flush();
			continue;
		}

		// Age check
		if (b.turn > ageCutoff) {
			flush();
			continue;
		}

		// Already in a group
		if (inGroup(b.id)) {
			flush();
			continue;
		}

		// tool_call: always eligible structurally (pair-balance checked in chunking below)
		// FOLDABLE kinds (text/thinking/tool_result): must be auto-folded.
		// Note: block-level cooldowns are NOT checked here — a block that ended up
		// auto-folded (even via the relaxed pass) is cold enough to coalesce. The
		// `isAutoFolded` check (autoFolded && override===null) is the authoritative gate.
		if (b.kind !== "tool_call" && !isAutoFolded(b)) {
			flush();
			continue;
		}

		current.push(b);
	}
	flush();

	// ── Pass 2: within each maximal run, verify tool-pair integrity ────────────
	// A tool_call is eligible ONLY if its callId partner (the matching tool_result)
	// is in the SAME maximal run. Scan each run, collect callIds of tool_calls and
	// tool_results, then rebuild the run removing "orphaned" tool_calls (whose
	// result is outside the run) and restarting the span if the run would split a pair.
	//
	// Strategy: scan the run and identify block indices that have an unmatched callId.
	// An unmatched tool_call splits the run at that boundary (its result is after or
	// outside → we can't include the call without including its result → break here).
	// An unmatched tool_result is auto-folded and carries no peer requirement — it stays.
	const validatedRuns: Block[][] = [];
	for (const run of maximalRuns) {
		// Build sets of callIds present in this run
		const callIds = new Set<string>(); // callIds of tool_call blocks in run
		const resultIds = new Set<string>(); // callIds of tool_result blocks in run
		for (const b of run) {
			if (b.callId) {
				if (b.kind === "tool_call") callIds.add(b.callId);
				else if (b.kind === "tool_result") resultIds.add(b.callId);
			}
		}

		// Pair integrity cuts BOTH ways:
		//  - an orphaned tool_call (result outside the run) would drag a live result
		//    into straggler territory — split at it;
		//  - an orphaned tool_result whose CALL exists elsewhere in the session would
		//    itself become a full-cost straggler after message snapping (this was a
		//    real budget-violation bug caught by the corpus eval) — split at it too.
		//    A result with no matching call anywhere stays (nothing to be split from).
		let seg: Block[] = [];
		const flushSeg = () => {
			if (seg.length > 0) {
				validatedRuns.push(seg);
				seg = [];
			}
		};
		for (const b of run) {
			if (b.kind === "tool_call" && b.callId && !resultIds.has(b.callId)) {
				// Orphaned call — break the run here (don't include this call)
				flushSeg();
				continue;
			}
			if (b.kind === "tool_result" && b.callId && !callIds.has(b.callId) && sessionCallIds.has(b.callId)) {
				// Result whose call lives outside the run — never separate the pair
				flushSeg();
				continue;
			}
			seg.push(b);
		}
		flushSeg();
	}

	// ── Pass 3: chunk runs to respect maxMembers and maxFullTokens ─────────────
	// Chunk boundaries must NOT split a tool_call/result pair. Strategy: accumulate
	// blocks into a chunk; when about to exceed either cap, flush the current chunk
	// first — but if the NEXT block is a tool_result whose call is already in the
	// current chunk, we MUST include it (don't split the pair): either absorb it even
	// if over cap (soft overrun), or backtrack and pull both call+result into next chunk.
	//
	// Simpler correct approach: when we would flush, check if the last block added is
	// a tool_call — if so, back it out and flush without it (next chunk starts with it
	// and its result stays together).
	const results: CoalesceRun[] = [];
	for (const run of validatedRuns) {
		let chunkStart = 0;
		while (chunkStart < run.length) {
			const chunk: Block[] = [];
			let tokenSum = 0;
			let i = chunkStart;
			// Track callIds of tool_calls added to this chunk — we must not flush
			// between a call and its result.
			const chunkCallIds = new Set<string>();

			while (i < run.length) {
				const b = run[i];
				const wouldExceedCount = chunk.length >= COALESCE_CONFIG.maxMembers;
				const wouldExceedTokens = tokenSum + b.tokens > COALESCE_CONFIG.maxFullTokens;

				if ((wouldExceedCount || wouldExceedTokens) && chunk.length > 0) {
					// Check if the last block in the chunk is a tool_call whose result
					// has NOT yet been added. If so, back the call out so call+result
					// move to the next chunk as a unit.
					const last = chunk[chunk.length - 1];
					if (last.kind === "tool_call" && last.callId && !chunkCallIds.has("result:" + last.callId)) {
						// Back out the call
						chunk.pop();
						chunkCallIds.delete(last.callId);
						tokenSum -= last.tokens;
					}
					break;
				}

				chunk.push(b);
				tokenSum += b.tokens;
				if (b.callId) {
					if (b.kind === "tool_call") chunkCallIds.add(b.callId);
					else if (b.kind === "tool_result") chunkCallIds.add("result:" + b.callId);
				}
				i++;
			}

			// Balance trim: a chunk boundary must never separate a call from its result
			// in EITHER direction (e.g. call1,call2,result1 | result2 — the simple
			// back-out above only handles a trailing call). Drop trailing blocks until
			// the chunk is pair-balanced; `i` retreats with each drop so the next chunk
			// resumes at the first dropped block.
			const isBalanced = (arr: Block[]): boolean => {
				const c = new Set<string>();
				const r = new Set<string>();
				for (const b of arr) {
					if (!b.callId) continue;
					if (b.kind === "tool_call") c.add(b.callId);
					else if (b.kind === "tool_result") r.add(b.callId);
				}
				for (const id of c) if (!r.has(id)) return false;
				for (const id of r) if (!c.has(id) && sessionCallIds.has(id)) return false;
				return true;
			};
			while (chunk.length > 0 && !isBalanced(chunk)) {
				const dropped = chunk.pop()!;
				tokenSum -= dropped.tokens;
				i--;
			}

			if (chunk.length >= COALESCE_CONFIG.minRun) {
				const firstId = chunk[0].id;
				const lastId = chunk[chunk.length - 1].id;
				if (!groupCoolActive(firstId)) {
					results.push({ startId: firstId, endId: lastId, memberCount: chunk.length });
				}
			}

			// Advance to the next chunk start
			if (i === chunkStart) {
				// Safety: no progress (e.g., a single block exceeds both caps). Skip it.
				chunkStart++;
			} else {
				chunkStart = i;
			}
		}
	}

	return results;
}

// ── Era formation (C4 nesting, ADR 0011 §7) ─────────────────────────────────
// Groups of adjacent folded conductor-built episodes can be coalesced upward into
// parent "era" groups. `findEraRuns` identifies runs of ≥ MIN_ERA_GROUPS adjacent
// folded leaf groups whose members are all old enough for era-level coalescing.

/** Minimum number of adjacent folded groups to form an era. */
export const MIN_ERA_GROUPS = 4;

/**
 * A group's member blocks must all be older than this many turns to be eligible for
 * era-level coalescing. "Older than ~300 turns" is the C4 target.
 */
export const ERA_AGE_TURNS = 300;

/**
 * Maximum number of child groups per era. The blast-radius at era level is bounded by
 * level-by-level unfold (only summaries are revealed), so this cap is generous compared
 * to C2.5's leaf-block cap.
 */
export const MAX_ERA_GROUPS = 20;

/**
 * Find runs of adjacent folded conductor-built groups that are candidates for upward
 * coalescing into era parent groups (ADR 0011 §7).
 *
 * @param groups      The store's current groups array (flat — includes both leaf and
 *                    existing parent groups).
 * @param blocks      The store's current blocks array (in conversation order).
 * @param currentTurn The current turn number (from the most recent block's `turn`).
 * @param blockIndex  A block-id → array-index map (the store's `index` map); if not
 *                    provided it is built from `blocks`. Pass the store's map for
 *                    efficiency when calling from a hot path.
 * @returns An array of child-group-id arrays, each representing one candidate era.
 *          Callers pass each to `store.createParentGroup`. Returns [] when no
 *          eligible runs exist.
 */
export function findEraRuns(
	groups: Group[],
	blocks: Block[],
	currentTurn: number,
	blockIndex?: ReadonlyMap<string, number>,
): string[][] {
	// Build the block index if not provided.
	const idx: ReadonlyMap<string, number> =
		blockIndex ??
		(() => {
			const m = new Map<string, number>();
			for (let i = 0; i < blocks.length; i++) m.set(blocks[i].id, i);
			return m;
		})();

	// Only consider TOP-LEVEL folded leaf groups (no children, not already a child of a
	// parent). Groups that already have children are era groups — skip them.
	const alreadyParented = new Set<string>();
	for (const g of groups) {
		if (g.children?.length) for (const cid of g.children) alreadyParented.add(cid);
	}

	// Filter to eligible leaf groups: folded, no children, not already parented, and
	// all leaf members older than ERA_AGE_TURNS.
	const eligible = groups.filter((g) => {
		if (!g.folded) return false;
		if (g.children?.length) return false; // already a parent
		if (alreadyParented.has(g.id)) return false; // already has a parent
		// All leaf members must be older than ERA_AGE_TURNS.
		for (const id of g.memberIds) {
			const i = idx.get(id);
			if (i === undefined) return false;
			const b = blocks[i];
			if (!b) return false;
			if (currentTurn - b.turn < ERA_AGE_TURNS) return false; // too recent
		}
		return true;
	});

	if (eligible.length < MIN_ERA_GROUPS) return [];

	// Sort eligible groups by the position of their first leaf member (conversation order).
	const firstMemberIdx = (g: Group): number => {
		let min = Infinity;
		for (const id of g.memberIds) {
			const i = idx.get(id);
			if (i !== undefined && i < min) min = i;
		}
		return min;
	};
	const sorted = [...eligible].sort((a, b) => firstMemberIdx(a) - firstMemberIdx(b));

	// Identify adjacent runs. Two consecutive groups in `sorted` are adjacent if:
	// there is no unfolded foldable block (kind != "user") between the last member
	// of the first group and the first member of the second group.
	// "user" blocks are allowed gaps — they are natural episode separators.
	const lastMemberIdx = (g: Group): number => {
		let max = -Infinity;
		for (const id of g.memberIds) {
			const i = idx.get(id);
			if (i !== undefined && i > max) max = i;
		}
		return max;
	};

	const runs: string[][] = [];
	let currentRun: string[] = [sorted[0].id];

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1];
		const curr = sorted[i];
		const prevLast = lastMemberIdx(prev);
		const currFirst = firstMemberIdx(curr);

		// Check the gap: any block between prevLast and currFirst that is a foldable
		// kind (not "user") and not a member of either group breaks adjacency.
		let adjacent = true;
		for (let bi = prevLast + 1; bi < currFirst; bi++) {
			const b = blocks[bi];
			if (!b) continue;
			if (b.kind === "user") continue; // allowed separator
			adjacent = false;
			break;
		}

		if (adjacent) {
			currentRun.push(curr.id);
			// Cap era size.
			if (currentRun.length >= MAX_ERA_GROUPS) {
				runs.push([...currentRun]);
				currentRun = [];
			}
		} else {
			if (currentRun.length >= MIN_ERA_GROUPS) runs.push([...currentRun]);
			currentRun = [curr.id];
		}
	}
	// Flush the final run.
	if (currentRun.length >= MIN_ERA_GROUPS) runs.push([...currentRun]);

	return runs;
}
