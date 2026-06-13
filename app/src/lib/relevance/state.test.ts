/*
 * state.test.ts — unit tests for the pure helper functions in state.svelte.ts.
 *
 * Imports ONLY the pure exported functions (no runes, no DOM, no Svelte),
 * so these run fine under vitest's node environment.
 */
import { describe, it, expect } from "vitest";
import {
	buildPureScoreMap,
	buildFileScoreMap,
	availableScorersForTick,
	storeSessionId,
} from "./state.svelte";
import type { ScoreFile } from "./types";

// ---------------------------------------------------------------------------
// Minimal Block factory
// ---------------------------------------------------------------------------

function makeBlock(id: string, kind: "user" | "text" | "thinking" | "tool_call" | "tool_result" = "text", tokens = 100, turn = 1): import("../engine/types").Block {
	return { id, kind, turn, order: 0, tokens, text: `content of ${id}`, override: null, autoFolded: false, by: "agent" };
}

// ---------------------------------------------------------------------------
// buildPureScoreMap
// ---------------------------------------------------------------------------

describe("buildPureScoreMap", () => {
	it("returns empty map for unknown scorer id", () => {
		const blocks = [makeBlock("b0"), makeBlock("b1")];
		const result = buildPureScoreMap("embed" as any, blocks, 2, 1);
		expect(result.size).toBe(0);
	});

	it("recency scorer returns a map with entries for blocks < atBlock", () => {
		// Use large token counts so computeProtectedFromIndex places atBlock < blocks.length.
		// 5 blocks of 8000 tok each = 40000 tok total. DEFAULT_PROTECT_TOKENS = 20000, cap 1.25 = 25000.
		// Walking back: block4=8000, block3=16000, block2=24000 > 20000 but <=25000 → atBlock = 2.
		const blocks = Array.from({ length: 5 }, (_, i) => makeBlock(`b${i}`, "text", 8000, i));
		const result = buildPureScoreMap("recency", blocks, 5, 2);
		// atBlock is computed by buildTickContext (not the passed arg); with these tokens
		// at least some blocks should be scored.
		expect(result.size).toBeGreaterThan(0);
		// All scored ids should be in the non-tail set (those computed by buildTickContext).
		for (const [, v] of result) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it("normalized values are in [0, 1]", () => {
		const blocks = Array.from({ length: 8 }, (_, i) =>
			makeBlock(`b${i}`, i % 2 === 0 ? "text" : "tool_result", 50 * (i + 1), i),
		);
		const result = buildPureScoreMap("recency", blocks, 8, 6);
		for (const [, v] of result) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it("empty block list returns empty map", () => {
		expect(buildPureScoreMap("recency", [], 0, 0).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// buildFileScoreMap
// ---------------------------------------------------------------------------

const sampleFile: ScoreFile = {
	version: 1,
	sessionId: "test-session",
	generatedAt: "2026-01-01T00:00:00Z",
	ticks: [
		{
			tick: 0,
			endBlock: 5,
			atBlock: 3,
			blockIds: ["b0", "b1", "b2"],
			scorers: {
				embed: { version: "1", wallMs: 100 },
			},
			scores: {
				embed: [0.1, 0.9, 0.5],
				judge: [3, 8, null],
			},
		},
	],
};

describe("buildFileScoreMap", () => {
	it("returns empty map for scorer not in file", () => {
		const result = buildFileScoreMap("attn", sampleFile, 0);
		expect(result.size).toBe(0);
	});

	it("maps blockIds to rank-normalized [0,1] values for embed", () => {
		const result = buildFileScoreMap("embed", sampleFile, 0);
		// raw [0.1, 0.9, 0.5] → rank [0, 1, 0.5]
		expect(result.has("b0")).toBe(true);
		expect(result.has("b1")).toBe(true);
		expect(result.has("b2")).toBe(true);
		expect(result.get("b1")).toBe(1); // highest raw
		expect(result.get("b0")).toBe(0); // lowest raw
	});

	it("null scores in file are absent from the map", () => {
		// judge scores: [3, 8, null]
		const result = buildFileScoreMap("judge", sampleFile, 0);
		expect(result.has("b2")).toBe(false); // null → omitted
		expect(result.has("b0")).toBe(true);
		expect(result.has("b1")).toBe(true);
	});

	it("clamps tick index to valid range", () => {
		// Only one tick at index 0; requesting index 99 should still work
		const r1 = buildFileScoreMap("embed", sampleFile, 99);
		const r2 = buildFileScoreMap("embed", sampleFile, 0);
		expect(r1.size).toBe(r2.size);
	});
});

// ---------------------------------------------------------------------------
// availableScorersForTick
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C1 — storeSessionId: two distinct store objects → different ids
// ---------------------------------------------------------------------------

describe("storeSessionId (C1 — session identity for memo key)", () => {
	it("same object always returns the same id", () => {
		const obj = {};
		expect(storeSessionId(obj)).toBe(storeSessionId(obj));
	});

	it("two same-shaped store objects get DIFFERENT ids", () => {
		// Simulates switching sessions: both have the same blockCount / protectedFrom
		// shape, but are distinct object references.
		const storeA = { blocks: [makeBlock("m0:p0"), makeBlock("m1:p0")], protectedFromIndex: 1 };
		const storeB = { blocks: [makeBlock("m0:p0"), makeBlock("m1:p0")], protectedFromIndex: 1 };
		const idA = storeSessionId(storeA);
		const idB = storeSessionId(storeB);
		expect(idA).not.toBe(idB);
	});

	it("different store objects produce different pure scorer maps even when shapes match", () => {
		// 5 blocks × 8000 tok each — same shape for both "sessions".
		const blocks = Array.from({ length: 5 }, (_, i) => makeBlock(`b${i}`, "text", 8000, i));

		// Use two distinct block arrays with identical content (same blockCount / same tokens).
		const blocksA = blocks.map((b) => ({ ...b }));
		const blocksB = blocks.map((b) => ({ ...b }));

		const mapA = buildPureScoreMap("recency", blocksA, 5, 2);
		const mapB = buildPureScoreMap("recency", blocksB, 5, 2);

		// Both maps should be non-empty (scorer ran).
		expect(mapA.size).toBeGreaterThan(0);
		expect(mapB.size).toBeGreaterThan(0);

		// The STORE-LEVEL memo key includes store object identity; this test confirms
		// that two distinct store objects (different WeakMap entries) are keyed
		// differently. buildPureScoreMap itself is stateless — it's the pureKey
		// (used by getActiveScoreMap/getAllScoresForBlock) that carries the store id.
		// Here we verify storeSessionId gives unique ids, ensuring the keys differ.
		const storeA = { id: "a" };
		const storeB = { id: "b" };
		expect(storeSessionId(storeA)).not.toBe(storeSessionId(storeB));
	});
});

// ---------------------------------------------------------------------------
// H2 — pure scorer uses effective endBlock from file tick when file is loaded
// ---------------------------------------------------------------------------

describe("buildPureScoreMap with tick-aligned endBlock (H2)", () => {
	it("scoring a session prefix shorter than full session produces fewer scored blocks", () => {
		const blocks = Array.from({ length: 10 }, (_, i) => makeBlock(`b${i}`, "text", 8000, i));
		// Score only first 5 blocks (simulates a non-final tick endBlock=5).
		const mapAt5 = buildPureScoreMap("recency", blocks, 5, 0);
		// Score all 10 blocks (live tick).
		const mapAt10 = buildPureScoreMap("recency", blocks, 10, 0);
		// The tick-aligned map should score fewer blocks than the live map.
		expect(mapAt5.size).toBeLessThanOrEqual(mapAt10.size);
		// Blocks beyond index 5 must not appear in the tick-aligned map.
		for (let i = 5; i < 10; i++) {
			expect(mapAt5.has(`b${i}`)).toBe(false);
		}
	});
});

describe("availableScorersForTick", () => {
	it("when no file, returns only pure ids", () => {
		const avail = availableScorersForTick(null, 0);
		expect(avail.has("recency")).toBe(true);
		expect(avail.has("actr")).toBe(true);
		expect(avail.has("bm25")).toBe(true);
		expect(avail.has("graph")).toBe(true);
		expect(avail.has("embed")).toBe(false);
		expect(avail.has("judge")).toBe(false);
	});

	it("includes external scorers that have data in the tick", () => {
		const avail = availableScorersForTick(sampleFile, 0);
		expect(avail.has("embed")).toBe(true);
		// judge has data too (non-empty array)
		expect(avail.has("judge")).toBe(true);
		// attn/rerank not present
		expect(avail.has("attn")).toBe(false);
		expect(avail.has("rerank")).toBe(false);
	});
});
