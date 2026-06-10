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

import type { Block } from "./types";

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

		// An orphaned tool_call (callId not in resultIds) would leave a straggler result
		// outside the group — a tool_call must NEVER appear in a group without its result.
		// Scan the run and split at any orphaned tool_call.
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
