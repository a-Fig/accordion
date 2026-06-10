/*
 * score.test.ts — unit tests for the ACT-R cold-score ranking.
 *
 * Key properties tested:
 *   1. Monotonic decay — older blocks have lower activation.
 *   2. Recall boost — a recalled block has higher activation than a never-recalled one.
 *   3. Kind-major ordering — default sort with no recalls matches legacy FOLD_RANK ordering.
 *   4. Golden compatibility — same fold set as the old clamp on a synthetic mixed session.
 */
import { describe, it, expect } from "vitest";
import type { Block, BlockKind } from "./types";
import { activation, coldScore, sortCandidates, SCORE_CONFIG } from "./score";
import type { ScoreCtx } from "./score";

function blk(id: string, kind: BlockKind, turn: number, order: number): Block {
	return {
		id,
		kind,
		turn,
		order,
		text: `block ${id}`,
		tokens: 1000,
		override: null,
		autoFolded: false,
		by: null,
	};
}

const emptyCtx = (currentTurn: number): ScoreCtx => ({
	currentTurn,
	recalls: new Map(),
	tailCallIds: new Set(),
});

describe("activation — monotonic decay", () => {
	it("an older block has lower activation than a newer one (same kind, no recalls)", () => {
		const newer = blk("newer", "text", 8, 1);
		const older = blk("older", "text", 2, 0);
		const ctx = emptyCtx(10);
		const actNewer = activation(newer, ctx);
		const actOlder = activation(older, ctx);
		// older = age 8, newer = age 2; both same decay; older decays more → lower activation
		expect(actOlder).toBeLessThan(actNewer);
	});

	it("activation increases with each recall event", () => {
		const b = blk("b1", "text", 1, 0);
		const ctx0 = emptyCtx(10);
		const ctx1: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["b1", [5]]]),
			tailCallIds: new Set(),
		};
		const ctx2: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["b1", [5, 8]]]),
			tailCallIds: new Set(),
		};
		const a0 = activation(b, ctx0);
		const a1 = activation(b, ctx1);
		const a2 = activation(b, ctx2);
		// More recalls → higher activation (more events in the sum)
		expect(a1).toBeGreaterThan(a0);
		expect(a2).toBeGreaterThan(a1);
	});

	it("activation is finite and a real number for reasonable inputs", () => {
		const b = blk("b1", "text", 1, 0);
		const ctx = emptyCtx(100);
		const a = activation(b, ctx);
		expect(Number.isFinite(a)).toBe(true);
		expect(Number.isNaN(a)).toBe(false);
	});
});

describe("coldScore — kind-major property", () => {
	it("tool_result always scores lower (colder) than thinking, which scores lower than text", () => {
		// No recalls, same turn, same order
		const ctx = emptyCtx(5);
		const tr = blk("tr", "tool_result", 2, 0);
		const th = blk("th", "thinking", 2, 1);
		const tx = blk("tx", "text", 2, 2);
		expect(coldScore(tr, ctx)).toBeLessThan(coldScore(th, ctx));
		expect(coldScore(th, ctx)).toBeLessThan(coldScore(tx, ctx));
	});

	it("a recall lifts a tool_result above an older thinking block (within-kind ordering)", () => {
		const ctx0 = emptyCtx(10);
		const old_tr = blk("old_tr", "tool_result", 1, 0);
		const newer_tr = blk("new_tr", "tool_result", 5, 1);
		// Older block should have lower score (fold first)
		expect(coldScore(old_tr, ctx0)).toBeLessThan(coldScore(newer_tr, ctx0));

		// Now recall the older block at turn 9 — it gets warmer (score increases)
		const ctx1: ScoreCtx = {
			currentTurn: 10,
			recalls: new Map([["old_tr", [9]]]),
			tailCallIds: new Set(),
		};
		// The recalled old_tr should be warmer than the non-recalled newer_tr
		expect(coldScore(old_tr, ctx1)).toBeGreaterThan(coldScore(newer_tr, ctx0));
	});

	it("pairWarmthBonus raises score for blocks whose callId is in the tail", () => {
		const ctx = emptyCtx(5);
		const tr_no_pair = blk("tr1", "tool_result", 2, 0);
		const tr_with_pair = { ...blk("tr2", "tool_result", 2, 1), callId: "c1" };
		const ctxWithTail: ScoreCtx = {
			currentTurn: 5,
			recalls: new Map(),
			tailCallIds: new Set(["c1"]),
		};
		// The paired block should have a higher (warmer) score
		expect(coldScore(tr_with_pair, ctxWithTail)).toBeGreaterThan(coldScore(tr_no_pair, ctx));
		expect(coldScore(tr_with_pair, ctxWithTail) - coldScore(tr_no_pair, ctx)).toBeCloseTo(
			SCORE_CONFIG.pairWarmthBonus,
			0,
		);
	});
});

describe("sortCandidates — default ordering matches legacy FOLD_RANK", () => {
	it("no recalls: sort order equals legacy FOLD_RANK then age on a synthetic mixed session", () => {
		// The golden-compatibility property: with no recalls, cold score ordering
		// reproduces FOLD_RANK-then-age. "Age" here is turn-based (older turn = older block).
		// To produce a clean oracle, each kind group has strictly monotonic turns AND orders
		// so there is no ambiguity between "older by turn" and "older by order".
		const ctx = emptyCtx(12);
		// Build blocks where turn and order are co-monotonic within each kind group:
		//   tool_result: turns 1,4,7 → orders 0,3,6
		//   thinking:    turns 2,5,8 → orders 1,4,7
		//   text:        turns 3,6,9 → orders 2,5,8
		// (user/tool_call excluded since sortCandidates only deals with FOLDABLE kinds in practice)
		const blocks: Block[] = [
			blk("tr_1", "tool_result", 1, 0),
			blk("th_1", "thinking", 2, 1),
			blk("tx_1", "text", 3, 2),
			blk("tr_2", "tool_result", 4, 3),
			blk("th_2", "thinking", 5, 4),
			blk("tx_2", "text", 6, 5),
			blk("tr_3", "tool_result", 7, 6),
			blk("th_3", "thinking", 8, 7),
			blk("tx_3", "text", 9, 8),
		];

		// Legacy oracle: FOLD_RANK then order asc within kind
		const FOLD_RANK_ORACLE: Record<string, number> = {
			tool_result: 0,
			thinking: 1,
			text: 2,
			tool_call: 3,
			user: 4,
		};
		const legacyOrder = [...blocks].sort(
			(a, b) => FOLD_RANK_ORACLE[a.kind] - FOLD_RANK_ORACLE[b.kind] || a.order - b.order,
		);

		const newOrder = sortCandidates(blocks, ctx);

		// Extract the kind+order sequence
		const legacySeq = legacyOrder.map((b) => `${b.kind}:${b.order}`);
		const newSeq = newOrder.map((b) => `${b.kind}:${b.order}`);

		expect(newSeq).toEqual(legacySeq);
	});

	it("ties broken by order (oldest first)", () => {
		const ctx = emptyCtx(5);
		const b1 = blk("a", "text", 1, 3);
		const b2 = blk("b", "text", 1, 1);
		const b3 = blk("c", "text", 1, 2);
		const sorted = sortCandidates([b1, b3, b2], ctx);
		// All same kind, same turn → tie on score → order breaks tie (oldest=lowest order first)
		expect(sorted.map((b) => b.id)).toEqual(["b", "c", "a"]);
	});
});
