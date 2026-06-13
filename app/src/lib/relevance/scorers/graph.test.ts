import { describe, it, expect } from "vitest";
import { graphScorer, params } from "./graph";
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

function ctx(
	blocks: Block[],
	atBlock: number,
	endBlock?: number,
): TickContext {
	const eb = endBlock ?? blocks.length;
	const tailText = blocks
		.slice(atBlock, eb)
		.map((b) => b.text)
		.join("\n\n");
	// tailIdents not used by graphScorer directly but required by interface
	return {
		blocks,
		endBlock: eb,
		atBlock,
		tailText,
		tailIdents: [],
	};
}

// ---------------------------------------------------------------------------
// Basic / metadata
// ---------------------------------------------------------------------------

describe("graphScorer — basic", () => {
	it("has correct id and version", () => {
		expect(graphScorer.id).toBe("graph");
		expect(graphScorer.version).toBe("1");
	});

	it("exports params with expected values", () => {
		expect(params.hops).toBe(2);
		expect(params.decay).toBe(0.5);
		expect(params.dfCapRatio).toBe(0.25);
		expect(params.fanoutCap).toBe(50);
	});

	it("returns array of length atBlock", () => {
		const blocks = [
			blk("b0", "appendBlocks is important"),
			blk("b1", "appendBlocks is called again"),
			blk("b2", "tail: appendBlocks and more"),
		];
		const result = graphScorer.score(ctx(blocks, 2));
		expect(result).toHaveLength(2);
	});

	it("returns empty array when atBlock=0", () => {
		const blocks = [blk("b0", "tail block appendBlocks")];
		const result = graphScorer.score(ctx(blocks, 0));
		expect(result).toHaveLength(0);
	});

	it("returns all-zero when no distinctive idents connect blocks", () => {
		// Each ident appears in only 1 block (df<2) → no edges → no propagation
		const blocks = [
			blk("b0", "uniqueIdentOne is here"),
			blk("b1", "uniqueIdentTwo is elsewhere"),
			blk("b2", "tailIdent in the tail"),
		];
		const result = graphScorer.score(ctx(blocks, 2)) as number[];
		expect(result.every((s) => s === 0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 1-hop neighbor outranks 2-hop, 2-hop outranks disconnected
// ---------------------------------------------------------------------------

describe("graphScorer — hop ordering", () => {
	it("1-hop neighbor > 2-hop neighbor > disconnected block", () => {
		/*
		 * We need dfThreshold > 2 so df=2 idents are distinctive.
		 * dfThreshold = prefixLen * 0.25, so we need prefixLen >= 9.
		 *
		 * Layout (12 blocks total, 11 scored + 1 tail):
		 *  b0: has sharedXYZ → 1-hop neighbor of tail (shares sharedXYZ with tail)
		 *  b1: has linkABC that links to b0 (b0 also has linkABC) → 2-hop
		 *  b2: completely unrelated to tail
		 *  b3-b10: padding blocks with unique idents (df=1 each, no edges)
		 *  b11 (tail): has sharedXYZ
		 *
		 * sharedXYZ: df=2 (b0 + b11), dfThreshold=12*0.25=3 → 2 < 3 → distinctive ✓
		 * linkABC: df=2 (b0 + b1), distinctive ✓
		 */
		const blocks: Block[] = [
			blk("b0", "sharedXYZ and linkABC appear here"), // 1-hop
			blk("b1", "linkABC connects this block alone"), // 2-hop
			blk("b2", "completelyUnrelated content alone"), // disconnected
			// padding blocks with unique idents (df=1, no edges created)
			blk("b3", "uniqueAlpha filler content here"),
			blk("b4", "uniqueBeta filler content here"),
			blk("b5", "uniqueGamma filler content here"),
			blk("b6", "uniqueDelta filler content here"),
			blk("b7", "uniqueEpsilon filler content here"),
			blk("b8", "uniqueZeta filler content here"),
			blk("b9", "uniqueEta filler content here"),
			blk("b10", "uniqueTheta filler content here"),
			blk("b11", "tail block contains sharedXYZ here"), // tail seed
		];

		// prefixLen=12, dfThreshold=3; sharedXYZ and linkABC have df=2 → distinctive
		const result = graphScorer.score(ctx(blocks, 11)) as number[];
		const s0 = result[0]; // 1-hop
		const s1 = result[1]; // 2-hop
		const s2 = result[2]; // disconnected

		expect(s0).toBeGreaterThan(s1); // 1-hop > 2-hop
		expect(s1).toBeGreaterThan(s2); // 2-hop > disconnected
	});
});

// ---------------------------------------------------------------------------
// Hub idents (df > fanoutCap) are ignored
// ---------------------------------------------------------------------------

describe("graphScorer — hub ident ignored", () => {
	it("hub ident (posting list > fanoutCap) does not propagate activation", () => {
		/*
		 * Create fanoutCap+2 blocks all containing hubIdent.
		 * The tail block also has hubIdent.
		 * Since hubIdent's posting list length > fanoutCap → skipped → all scores 0.
		 * To confirm the mechanism, also add a non-hub ident between tail and b0.
		 */
		const { fanoutCap } = params;
		const blocks: Block[] = [];

		// b0 has uniqueEdge shared with tail → should score via uniqueEdge
		blocks.push(blk("b0", `hubIdent and uniqueEdge here`));
		// b1..b(fanoutCap) each have hubIdent but NOT uniqueEdge → score only via hub (which is blocked)
		for (let i = 1; i <= fanoutCap; i++) {
			blocks.push(blk(`b${i}`, `hubIdent in block ${i} only`));
		}
		// tail
		blocks.push(blk(`b${fanoutCap + 1}`, `tail block has hubIdent and uniqueEdge`));

		const atBlock = fanoutCap + 1;
		const result = graphScorer.score(ctx(blocks, atBlock)) as number[];

		// b0 shares uniqueEdge with tail (df=2) → should get activation
		// b1..b(fanoutCap) only share hubIdent → hubIdent posting list is fanoutCap+2 > fanoutCap → blocked
		expect(result[0]).toBeGreaterThan(0); // uniqueEdge path works

		// All blocks that only share hubIdent should have 0
		for (let i = 1; i < atBlock; i++) {
			expect(result[i]).toBe(0);
		}
	});
});

// ---------------------------------------------------------------------------
// df=1 idents create no edges
// ---------------------------------------------------------------------------

describe("graphScorer — df=1 idents create no edges", () => {
	it("singleton ident (df=1) does not create edges even if in tail", () => {
		/*
		 * b0 has onlyHereIdent that appears only in b0 → df=1 → no edges created.
		 * Padding blocks bring prefixLen to 12 so dfThreshold=3.
		 */
		const blocks: Block[] = [
			blk("b0", "onlyHereIdent is unique to this block"),
			blk("b1", "tailOnlyIdent is in the tail alone"), // tail
			// ensure dfThreshold > 2 by adding padding
			blk("b2", "paddingAlpha content here only"),
			blk("b3", "paddingBeta content here only"),
			blk("b4", "paddingGamma content here only"),
			blk("b5", "paddingDelta content here only"),
			blk("b6", "paddingEpsilon content here only"),
			blk("b7", "paddingZeta content here only"),
			blk("b8", "paddingEta content here only"),
			blk("b9", "paddingTheta content here only"),
			blk("b10", "paddingIota content here only"),
			blk("b11", "tailOnlyIdent at end here"), // extra tail block
		];
		// atBlock=1 so only b0 is scored; tail=[b1..b11]
		const result = graphScorer.score(ctx(blocks, 1, 12)) as number[];
		// onlyHereIdent df=1 → no edges → score 0
		expect(result[0]).toBe(0);
	});

	it("df=2 ident (appears in both scored block and tail) — edge exists when prefix large enough", () => {
		/*
		 * sharedIdent appears in b0 AND the tail block → df=2.
		 * Prefix=12 blocks → dfThreshold=3 → 2 < 3 → distinctive → edge.
		 * Hop 1: tail seeds propagate through sharedIdent to b0 → b0 gets activation > 0.
		 */
		const blocks: Block[] = [
			blk("b0", "sharedIdent is here too"),
			blk("b1", "paddingAlpha content here only"),
			blk("b2", "paddingBeta content here only"),
			blk("b3", "paddingGamma content here only"),
			blk("b4", "paddingDelta content here only"),
			blk("b5", "paddingEpsilon content here only"),
			blk("b6", "paddingZeta content here only"),
			blk("b7", "paddingEta content here only"),
			blk("b8", "paddingTheta content here only"),
			blk("b9", "paddingIota content here only"),
			blk("b10", "paddingKappa content here only"),
			blk("b11", "tail block mentions sharedIdent again"), // tail
		];
		// atBlock=11; only b0..b10 scored; b11 is tail
		const result = graphScorer.score(ctx(blocks, 11, 12)) as number[];
		expect(result[0]).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// No self-amplification
// ---------------------------------------------------------------------------

describe("graphScorer — no self-amplification", () => {
	it("a block does not amplify itself (no self-loops), b1 > b0 hop ordering", () => {
		/*
		 * b0 and b1 both share bridgeIdent (distinctive since df=2 and prefix large).
		 * b1 and tail share tailIdent (df=2 → distinctive).
		 * Hop 1: tail seeds propagate through tailIdent to b1.
		 * Hop 2: b1 propagates through bridgeIdent to b0.
		 * b1 must not gain extra activation from itself (no self-loop).
		 *
		 * Padding ensures dfThreshold=12*0.25=3 > 2.
		 */
		const blocks: Block[] = [
			blk("b0", "bridgeIdent and nothing else here"), // 2-hop
			blk("b1", "bridgeIdent and tailIdent appear here"), // 1-hop
			blk("b2", "paddingAlpha content here only"),
			blk("b3", "paddingBeta content here only"),
			blk("b4", "paddingGamma content here only"),
			blk("b5", "paddingDelta content here only"),
			blk("b6", "paddingEpsilon content here only"),
			blk("b7", "paddingZeta content here only"),
			blk("b8", "paddingEta content here only"),
			blk("b9", "paddingTheta content here only"),
			blk("b10", "paddingIota content here only"),
			blk("b11", "tail block has tailIdent here"), // tail
		];
		const result = graphScorer.score(ctx(blocks, 11, 12)) as number[];
		for (const s of result) {
			expect(Number.isFinite(s)).toBe(true);
			expect(s).toBeGreaterThanOrEqual(0);
		}
		// b1 is 1-hop from tail (tailIdent); b0 is 2-hop (bridgeIdent via b1)
		expect(result[1]).toBeGreaterThan(result[0]);
	});
});

// ---------------------------------------------------------------------------
// Alignment / length invariant
// ---------------------------------------------------------------------------

describe("graphScorer — alignment", () => {
	it("result length equals atBlock for various values", () => {
		const blocks = Array.from({ length: 10 }, (_, i) =>
			blk(`b${i}`, `sharedIdent block number ${i}`),
		);
		for (let at = 0; at <= 10; at++) {
			const result = graphScorer.score(ctx(blocks, at, 10));
			expect(result).toHaveLength(at);
		}
	});

	it("all scores are finite non-negative numbers", () => {
		const blocks = Array.from({ length: 6 }, (_, i) =>
			blk(`b${i}`, `sharedIdent and moreData block ${i}`),
		);
		const result = graphScorer.score(ctx(blocks, 5)) as number[];
		for (const s of result) {
			expect(Number.isFinite(s)).toBe(true);
			expect(s).toBeGreaterThanOrEqual(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Integration: real sample slice (node:fs allowed in test files)
// ---------------------------------------------------------------------------

describe("graphScorer — integration (real sample)", () => {
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

		// Use first 150 blocks; tail = last 20 of those.
		const prefix = blocks.slice(0, 150);
		const atBlock = 130;
		const tailText = prefix
			.slice(atBlock)
			.map((b) => b.text)
			.join("\n\n");

		const context: TickContext = {
			blocks: prefix,
			endBlock: 150,
			atBlock,
			tailText,
			tailIdents: [],
		};

		const result = graphScorer.score(context) as number[];
		expect(result).toHaveLength(atBlock);

		const hasNaN = result.some((s) => !Number.isFinite(s as number));
		expect(hasNaN).toBe(false);

		const allZero = result.every((s) => s === 0);
		expect(allZero).toBe(false);
	});
});
