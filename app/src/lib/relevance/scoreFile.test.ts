import { describe, it, expect } from "vitest";
import { validateScoreFile, emptyTick, mergeScorerResult } from "./scoreFile";
import type { ScoreFile, TickContext } from "./types";
import type { Block } from "../engine/types";

function makeBlock(id: string, tokens = 100): Block {
	return {
		id,
		kind: "text",
		turn: 1,
		order: 0,
		text: "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeCtx(
	blockIds: string[],
	atBlock: number,
	endBlock?: number,
): TickContext {
	const blocks = blockIds.map((id) => makeBlock(id));
	return {
		blocks,
		endBlock: endBlock ?? blocks.length,
		atBlock,
		tailText: "tail",
		tailIdents: ["tail"],
	};
}

describe("validateScoreFile", () => {
	it("accepts a valid v1 score file", () => {
		const valid: ScoreFile = {
			version: 1,
			sessionId: "my-session",
			generatedAt: "2026-06-10T00:00:00.000Z",
			ticks: [
				{
					tick: 0,
					endBlock: 10,
					atBlock: 8,
					blockIds: ["b0", "b1"],
					scorers: {},
					scores: {},
				},
			],
		};
		expect(validateScoreFile(valid)).not.toBeNull();
	});

	it("rejects version !== 1", () => {
		const bad = {
			version: 2,
			sessionId: "x",
			generatedAt: "2026-01-01T00:00:00Z",
			ticks: [],
		};
		expect(validateScoreFile(bad)).toBeNull();
	});

	it("rejects missing sessionId", () => {
		const bad = { version: 1, generatedAt: "2026-01-01T00:00:00Z", ticks: [] };
		expect(validateScoreFile(bad)).toBeNull();
	});

	it("rejects missing ticks", () => {
		const bad = { version: 1, sessionId: "x", generatedAt: "2026-01-01T00:00:00Z" };
		expect(validateScoreFile(bad)).toBeNull();
	});

	it("rejects non-object", () => {
		expect(validateScoreFile(null)).toBeNull();
		expect(validateScoreFile("string")).toBeNull();
		expect(validateScoreFile(42)).toBeNull();
	});

	it("rejects tick with missing endBlock", () => {
		const bad = {
			version: 1,
			sessionId: "x",
			generatedAt: "2026-01-01T00:00:00Z",
			ticks: [{ tick: 0, atBlock: 0, blockIds: [], scorers: {}, scores: {} }],
		};
		expect(validateScoreFile(bad)).toBeNull();
	});

	it("roundtrip: parse → validate → same structure", () => {
		const original: ScoreFile = {
			version: 1,
			sessionId: "abc",
			generatedAt: "2026-06-10T12:00:00.000Z",
			ticks: [],
		};
		const reparsed = JSON.parse(JSON.stringify(original));
		const result = validateScoreFile(reparsed);
		expect(result).not.toBeNull();
		expect(result?.sessionId).toBe("abc");
		expect(result?.version).toBe(1);
	});
});

describe("emptyTick", () => {
	it("sets blockIds to ids of blocks [0, atBlock)", () => {
		const ctx = makeCtx(["b0", "b1", "b2", "b3"], 2, 4);
		const tick = emptyTick(ctx, 0);
		expect(tick.blockIds).toEqual(["b0", "b1"]);
	});

	it("sets correct tick ordinal", () => {
		const ctx = makeCtx(["b0"], 1, 1);
		expect(emptyTick(ctx, 5).tick).toBe(5);
	});

	it("sets endBlock and atBlock from context", () => {
		const ctx = makeCtx(["b0", "b1", "b2"], 2, 3);
		const tick = emptyTick(ctx, 0);
		expect(tick.endBlock).toBe(3);
		expect(tick.atBlock).toBe(2);
	});

	it("starts with empty scorers and scores", () => {
		const ctx = makeCtx(["b0"], 1);
		const tick = emptyTick(ctx, 0);
		expect(Object.keys(tick.scorers)).toHaveLength(0);
		expect(Object.keys(tick.scores)).toHaveLength(0);
	});

	it("blockIds align with atBlock — exactly atBlock entries", () => {
		const ctx = makeCtx(["a", "b", "c", "d", "e"], 3, 5);
		const tick = emptyTick(ctx, 0);
		expect(tick.blockIds.length).toBe(3);
	});
});

describe("mergeScorerResult", () => {
	it("adds scorer meta and scores to tick", () => {
		const ctx = makeCtx(["b0", "b1"], 2);
		const tick = emptyTick(ctx, 0);
		mergeScorerResult(tick, "recency", { version: "1", wallMs: 5 }, [0.5, 0.8]);
		expect(tick.scorers["recency"]).toEqual({ version: "1", wallMs: 5 });
		expect(tick.scores["recency"]).toEqual([0.5, 0.8]);
	});

	it("overwrites existing scorer entry", () => {
		const ctx = makeCtx(["b0"], 1);
		const tick = emptyTick(ctx, 0);
		mergeScorerResult(tick, "recency", { version: "1" }, [0.1]);
		mergeScorerResult(tick, "recency", { version: "2" }, [0.9]);
		expect(tick.scorers["recency"]?.version).toBe("2");
		expect(tick.scores["recency"]).toEqual([0.9]);
	});

	it("supports null scores (abstention)", () => {
		const ctx = makeCtx(["b0", "b1"], 2);
		const tick = emptyTick(ctx, 0);
		mergeScorerResult(tick, "bm25", { version: "1" }, [null, 0.5]);
		expect(tick.scores["bm25"]).toEqual([null, 0.5]);
	});
});
