import { describe, it, expect } from "vitest";
import { bm25Scorer, params } from "./bm25";
import type { Block } from "../../engine/types";
import type { TickContext } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blk(id: string, text: string, tokens?: number): Block {
	return {
		id,
		kind: "text",
		turn: 0,
		order: 0,
		text,
		tokens: tokens ?? Math.ceil(text.length / 4) + 3,
		override: null,
		autoFolded: false,
		by: null,
	};
}

/**
 * Build a minimal TickContext from a blocks array.
 * atBlock = index where the "tail" starts; endBlock defaults to blocks.length.
 * tailIdents must be provided explicitly (mirrors how buildTickContext works).
 */
function ctx(
	blocks: Block[],
	atBlock: number,
	tailIdents: string[],
	endBlock?: number,
): TickContext {
	const eb = endBlock ?? blocks.length;
	return {
		blocks,
		endBlock: eb,
		atBlock,
		tailText: tailIdents.join(" "),
		tailIdents,
	};
}

// ---------------------------------------------------------------------------
// Basic correctness
// ---------------------------------------------------------------------------

describe("bm25Scorer — basic", () => {
	it("has correct id and version", () => {
		expect(bm25Scorer.id).toBe("bm25");
		expect(bm25Scorer.version).toBe("1");
	});

	it("exports params with k1=1.2 and b=0.75", () => {
		expect(params.k1).toBe(1.2);
		expect(params.b).toBe(0.75);
	});

	it("returns array of length atBlock", () => {
		const blocks = [
			blk("b0", "call appendBlocks here"),
			blk("b1", "some other text"),
			blk("b2", "appendBlocks in the tail"), // tail
		];
		const result = bm25Scorer.score(ctx(blocks, 2, ["appendblocks"]));
		expect(result).toHaveLength(2);
	});

	it("returns all-zero array when tailIdents is empty", () => {
		const blocks = [blk("b0", "appendBlocks here"), blk("b1", "tail text")];
		const result = bm25Scorer.score(ctx(blocks, 1, []));
		expect(result).toEqual([0]);
	});

	it("returns all-zero array for atBlock=0", () => {
		const blocks = [blk("b0", "tail block appendBlocks")];
		const result = bm25Scorer.score(ctx(blocks, 0, ["appendblocks"]));
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Block containing tail identifier outranks one without
// ---------------------------------------------------------------------------

describe("bm25Scorer — matching block outranks non-matching", () => {
	it("block with tail ident scores higher than disjoint block", () => {
		const blocks = [
			blk("b0", "the cat sat on a mat"), // no tail idents
			blk("b1", "appendBlocks is important here"), // has tail ident
			blk("b2", "appendBlocks in the tail"), // tail
		];
		const result = bm25Scorer.score(ctx(blocks, 2, ["appendblocks"]));
		const [s0, s1] = result as number[];
		expect(s1).toBeGreaterThan(s0);
	});

	it("score is 0 for completely disjoint blocks", () => {
		const blocks = [
			blk("b0", "the weather is nice today outside"),
			blk("b1", "appendBlocks in tail"),
		];
		const result = bm25Scorer.score(ctx(blocks, 1, ["appendblocks"]));
		expect(result[0]).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// IDF: rare ident outranks common ident
// ---------------------------------------------------------------------------

describe("bm25Scorer — IDF: rare ident outranks common ident", () => {
	it("block with rare ident scores higher than block with common ident", () => {
		// rareSymbol appears in only 1 of N blocks → high IDF
		// commonSymbol appears in many blocks → low IDF
		const blocks: Block[] = [];
		// 8 blocks with commonSymbol
		for (let i = 0; i < 8; i++) {
			blocks.push(blk(`b${i}`, `commonSymbol is used in block ${i}`));
		}
		// 1 block with rareSymbol
		blocks.push(blk("b8", "rareSymbol is used once here"));
		// 1 block with both (for comparison)
		blocks.push(blk("b9", "commonSymbol and rareSymbol both here"));
		// tail block
		blocks.push(blk("b10", "tail: commonSymbol rareSymbol"));

		const result = bm25Scorer.score(
			ctx(blocks, 10, ["commonsymbol", "raresymbol"]),
		) as number[];

		// b8 has only rareSymbol (1 occurrence); b0 has only commonSymbol (1 occurrence).
		// rareSymbol has df=2, commonSymbol has df=9 → rareSymbol idf > commonSymbol idf.
		// b8 score should be > b0 score (same tf=1, same dl, but rareSymbol > commonSymbol IDF).
		expect(result[8]).toBeGreaterThan(result[0]);
	});
});

// ---------------------------------------------------------------------------
// TF saturation: 5 mentions not 5× score of 1 mention
// ---------------------------------------------------------------------------

describe("bm25Scorer — TF saturation", () => {
	it("5 occurrences of ident gives less than 5× score of 1 occurrence", () => {
		const ident = "appendBlocks";
		// block with 1 occurrence
		const blocks1 = [
			blk("b0", `${ident} is called here`),
			blk("b1", `tail uses ${ident}`),
		];
		// block with 5 occurrences
		const blocks5 = [
			blk(
				"b0",
				`${ident} ${ident} ${ident} ${ident} ${ident} called five times`,
			),
			blk("b1", `tail uses ${ident}`),
		];

		const [score1] = bm25Scorer.score(
			ctx(blocks1, 1, ["appendblocks"]),
		) as number[];
		const [score5] = bm25Scorer.score(
			ctx(blocks5, 1, ["appendblocks"]),
		) as number[];

		expect(score5).toBeGreaterThan(score1);
		expect(score5).toBeLessThan(score1 * 5);
	});
});

// ---------------------------------------------------------------------------
// Length normalization
// ---------------------------------------------------------------------------

describe("bm25Scorer — length normalization", () => {
	it("short block with 1 ident scores higher than long block with same ident", () => {
		// BM25 doc length = total ident occurrences (only identifiable tokens count).
		// Short block: just the query ident → dl=1.
		// Long block: query ident surrounded by many other camelCase identifiers → dl large.
		// Both have tf=1 for the query ident; the long block is penalised by length norm.
		const filler = Array.from({ length: 60 }, (_, i) => `fillerToken${i}`).join(" ");
		const blocks = [
			blk("b0", `appendBlocks`), // short: dl ~ 1
			blk("b1", `${filler} appendBlocks ${filler}`), // long: dl ~ 121
			blk("b2", "tail appendBlocks"),
		];
		const result = bm25Scorer.score(
			ctx(blocks, 2, ["appendblocks"]),
		) as number[];
		// Short block should score higher (length normalization penalises long blocks)
		expect(result[0]).toBeGreaterThan(result[1]);
	});
});

// ---------------------------------------------------------------------------
// Alignment / length invariant
// ---------------------------------------------------------------------------

describe("bm25Scorer — alignment", () => {
	it("result length equals atBlock for various atBlock values", () => {
		const blocks = Array.from({ length: 10 }, (_, i) =>
			blk(`b${i}`, `block content appendBlocks ${i}`),
		);
		for (let at = 0; at <= 10; at++) {
			const result = bm25Scorer.score(ctx(blocks, at, ["appendblocks"], 10));
			expect(result).toHaveLength(at);
		}
	});

	it("all scores are finite numbers (no NaN, no Infinity)", () => {
		const blocks = Array.from({ length: 5 }, (_, i) =>
			blk(`b${i}`, `appendBlocks ${i} more text here`),
		);
		const result = bm25Scorer.score(
			ctx(blocks, 4, ["appendblocks"]),
		) as number[];
		for (const s of result) {
			expect(Number.isFinite(s)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: real sample slice (node:fs allowed in test files)
// ---------------------------------------------------------------------------

describe("bm25Scorer — integration (real sample)", () => {
	it("no NaN/Infinity, not all-zero over a real sample slice", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { parse } = await import("../../engine/parse");

		const samplePath = path.resolve(
			__dirname,
			"../../../../static/sample-session.jsonl",
		);
		const raw = fs.readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);

		// Use first 100 blocks; tail = last 20 of those.
		const prefix = blocks.slice(0, 100);
		const atBlock = 80;
		const tailText = prefix
			.slice(atBlock)
			.map((b) => b.text)
			.join("\n\n");

		const { extractIdents } = await import("../extract");
		const tailIdents = extractIdents(tailText);

		const context: TickContext = {
			blocks: prefix,
			endBlock: 100,
			atBlock,
			tailText,
			tailIdents,
		};

		const result = bm25Scorer.score(context) as number[];
		expect(result).toHaveLength(atBlock);

		const hasNaN = result.some((s) => !Number.isFinite(s as number));
		expect(hasNaN).toBe(false);

		const allZero = result.every((s) => s === 0);
		expect(allZero).toBe(false);
	});
});
