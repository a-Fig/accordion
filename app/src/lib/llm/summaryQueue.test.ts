/*
 * summaryQueue.test.ts — unit tests for the pure parts of the summary queue.
 *
 * Tests selectCandidates and prioritizeCandidates with synthetic stores.
 * No network or Tauri calls — all LLM / disk parts are excluded.
 *
 * Covers:
 *   - selectCandidates: skips protected, non-foldable, too-small, already-summarized,
 *     in-flight, failed, cached blocks
 *   - selectCandidates: includes eligible blocks only when their key is in keyMemo
 *   - prioritizeCandidates: folded blocks before unfolded, largest first within tier
 *   - key memoization: blocks without memoized key are skipped
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, ParsedSession } from "../engine/types";
import { SummaryCacheMem } from "../engine/summaryCache";
import { selectCandidates, prioritizeCandidates } from "./summaryQueue.svelte";

// ── Helpers ──────────────────────────────────────────────────────────────────

function blk(
	id: string,
	kind: Block["kind"] = "text",
	tokens: number = 1000,
	text?: string,
): Block {
	const t = text ?? `block ${id} ` + "x".repeat(tokens * 4 + 20);
	return {
		id,
		kind,
		turn: 1,
		order: 0,
		text: t,
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

// ── selectCandidates ──────────────────────────────────────────────────────────

describe("selectCandidates", () => {
	it("returns an eligible block when all conditions are met", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected tail
		const store = makeStore([b0, b1]);
		store.setProtect(300); // protect b1 (200 tokens)

		const keyMemo = new Map([["m0:p0", "key0"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result.map((b) => b.id)).toEqual(["m0:p0"]);
	});

	it("skips protected blocks (index >= protectedFromIndex)", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 500); // will be protected
		const store = makeStore([b0, b1]);
		store.setProtect(600); // protects b1

		const keyMemo = new Map([["m0:p0", "k0"], ["m1:p0", "k1"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result.map((b) => b.id)).not.toContain("m1:p0");
	});

	it("skips non-foldable kinds (user, tool_call)", () => {
		const b0 = blk("m0:p0", "user", 500);
		const b1 = blk("m1:p0", "tool_call", 500);
		const b2 = blk("m2:p0", "text", 200); // protected
		const store = makeStore([b0, b1, b2]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"], ["m1:p0", "k1"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(0);
	});

	it("skips blocks below MIN_TOKENS_FOR_SUMMARY (300)", () => {
		const b0 = blk("m0:p0", "text", 299); // just under threshold
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(0);
	});

	it("includes blocks at exactly MIN_TOKENS_FOR_SUMMARY (300)", () => {
		const b0 = blk("m0:p0", "text", 300);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result.map((b) => b.id)).toContain("m0:p0");
	});

	it("skips blocks that already have a summary applied", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);
		store.setSummary(b0.id, "already summarized");

		const keyMemo = new Map([["m0:p0", "k0"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(0);
	});

	it("skips in-flight block ids", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"]]);
		const cache = new SummaryCacheMem();
		const inFlight = new Set(["m0:p0"]);

		const result = selectCandidates(store, keyMemo, cache, inFlight, new Set());
		expect(result).toHaveLength(0);
	});

	it("skips failed block ids", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"]]);
		const cache = new SummaryCacheMem();
		const failed = new Set(["m0:p0"]);

		const result = selectCandidates(store, keyMemo, cache, new Set(), failed);
		expect(result).toHaveLength(0);
	});

	it("skips blocks whose key is already in the disk cache", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "existingKey"]]);
		const cache = new SummaryCacheMem();
		cache.put({ key: "existingKey", summary: "cached", kind: "text", model: "m", promptVersion: 1, srcTokens: 500, sumTokens: 10, at: 0 });

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(0);
	});

	it("skips blocks with no memoized key (key not yet computed)", () => {
		const b0 = blk("m0:p0", "text", 500);
		const b1 = blk("m1:p0", "text", 200); // protected
		const store = makeStore([b0, b1]);
		store.setProtect(300);

		const keyMemo = new Map<string, string>(); // empty — key not computed yet
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(0); // skipped because key missing
	});

	it("returns multiple eligible blocks", () => {
		const b0 = blk("m0:p0", "text", 600);
		const b1 = blk("m1:p0", "thinking", 400);
		const b2 = blk("m2:p0", "tool_result", 350);
		const b3 = blk("m3:p0", "text", 200); // protected
		const store = makeStore([b0, b1, b2, b3]);
		store.setProtect(300);

		const keyMemo = new Map([["m0:p0", "k0"], ["m1:p0", "k1"], ["m2:p0", "k2"]]);
		const cache = new SummaryCacheMem();

		const result = selectCandidates(store, keyMemo, cache, new Set(), new Set());
		expect(result).toHaveLength(3);
	});
});

// ── prioritizeCandidates ──────────────────────────────────────────────────────

describe("prioritizeCandidates", () => {
	it("puts folded blocks before unfolded blocks", () => {
		const b0 = blk("m0:p0", "text", 500); // will be folded
		const b1 = blk("m1:p0", "text", 600); // large but unfolded
		const b2 = blk("m2:p0", "text", 200); // protected
		const store = makeStore([b0, b1, b2]);
		store.setProtect(300);
		store.setBudget(500); // forces b0 to fold (smaller)

		// b0 should be folded, b1 should be unfolded (protected or stays live)
		// Actually both are old — let's just fold b0 manually
		store.fold(b0.id);

		const candidates = [store.blocks[1], store.blocks[0]]; // b1 first, b0 second
		const sorted = prioritizeCandidates(store, candidates);

		// b0 is folded → should come first
		expect(sorted[0].id).toBe("m0:p0");
		expect(sorted[1].id).toBe("m1:p0");
	});

	it("sorts largest-first within the folded tier", () => {
		const b0 = blk("m0:p0", "text", 300);
		const b1 = blk("m1:p0", "text", 800);
		const b2 = blk("m2:p0", "text", 500);
		const tail = blk("m3:p0", "text", 200); // protected
		const store = makeStore([b0, b1, b2, tail]);
		store.setProtect(300);
		// Fold all three old blocks
		store.fold(b0.id);
		store.fold(b1.id);
		store.fold(b2.id);

		const candidates = [store.blocks[0], store.blocks[1], store.blocks[2]];
		const sorted = prioritizeCandidates(store, candidates);

		// All folded: should be sorted largest→smallest: b1(800), b2(500), b0(300)
		expect(sorted[0].id).toBe("m1:p0");
		expect(sorted[1].id).toBe("m2:p0");
		expect(sorted[2].id).toBe("m0:p0");
	});

	it("sorts largest-first within the unfolded tier", () => {
		const b0 = blk("m0:p0", "text", 300);
		const b1 = blk("m1:p0", "text", 800);
		const b2 = blk("m2:p0", "text", 500);
		const tail = blk("m3:p0", "text", 200);
		const store = makeStore([b0, b1, b2, tail]);
		store.setProtect(300);
		// No folds — all unfolded

		const candidates = [store.blocks[0], store.blocks[1], store.blocks[2]];
		const sorted = prioritizeCandidates(store, candidates);

		// All unfolded: largest first
		expect(sorted[0].id).toBe("m1:p0"); // 800
		expect(sorted[1].id).toBe("m2:p0"); // 500
		expect(sorted[2].id).toBe("m0:p0"); // 300
	});

	it("returns empty array for empty input", () => {
		const tail = blk("m0:p0", "text", 200);
		const store = makeStore([tail]);
		expect(prioritizeCandidates(store, [])).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const b0 = blk("m0:p0", "text", 300);
		const b1 = blk("m1:p0", "text", 800);
		const tail = blk("m2:p0", "text", 200);
		const store = makeStore([b0, b1, tail]);

		const input = [store.blocks[0], store.blocks[1]];
		const inputCopy = [...input];
		prioritizeCandidates(store, input);

		expect(input).toEqual(inputCopy);
	});
});
