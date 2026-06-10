import { describe, it, expect } from "vitest";
import { extractIdents, identCounts } from "./extract";
import type { Block } from "../engine/types";

function blk(id: string, text: string): Block {
	return {
		id,
		kind: "text",
		turn: 0,
		order: 0,
		text,
		tokens: Math.ceil(text.length / 4) + 3,
		override: null,
		autoFolded: false,
		by: null,
	};
}

describe("extractIdents — file paths", () => {
	it("extracts unix absolute path", () => {
		const ids = extractIdents("see /src/lib/foo.ts for details");
		expect(ids).toContain("/src/lib/foo.ts");
	});

	it("emits basename of unix path as separate ident", () => {
		const ids = extractIdents("/src/lib/foo.ts");
		expect(ids).toContain("foo.ts");
	});

	it("extracts relative path ./src/foo.svelte", () => {
		const ids = extractIdents("see ./src/foo.svelte");
		expect(ids).toContain("./src/foo.svelte");
		expect(ids).toContain("foo.svelte");
	});

	it("extracts relative path without leading dot: src/lib/engine/types.ts", () => {
		const ids = extractIdents("read src/lib/engine/types.ts");
		expect(ids).toContain("types.ts");
	});

	it("extracts Windows path", () => {
		const ids = extractIdents("C:\\Users\\foo\\bar.rs");
		expect(ids).toContain("bar.rs");
	});
});

describe("extractIdents — symbols", () => {
	it("extracts camelCase identifier", () => {
		const ids = extractIdents("call appendBlocks to add more");
		expect(ids).toContain("appendblocks");
	});

	it("extracts PascalCase identifier", () => {
		const ids = extractIdents("use AccordionStore here");
		expect(ids).toContain("accordionstore");
	});

	it("extracts snake_case identifier", () => {
		const ids = extractIdents("see protect_tokens setting");
		expect(ids).toContain("protect_tokens");
	});

	it("extracts SCREAMING_SNAKE identifier", () => {
		const ids = extractIdents("MAX_TICKS constant");
		expect(ids).toContain("max_ticks");
	});

	it("extracts kebab-case identifier", () => {
		const ids = extractIdents("svelte-check command");
		expect(ids).toContain("svelte-check");
	});

	it("does not match plain short words (less than 4 chars)", () => {
		const ids = extractIdents("the cat sat on a mat");
		// None of these should be in idents (all < 4 chars)
		expect(ids).not.toContain("the");
		expect(ids).not.toContain("cat");
	});

	it("does not match plain lowercase word without case change or separator", () => {
		// 'function' is a plain word — no internal case change, underscore, or hyphen
		const ids = extractIdents("call function hello world here");
		expect(ids).not.toContain("function");
		expect(ids).not.toContain("hello");
	});
});

describe("extractIdents — dotted chains and call names", () => {
	it("extracts dotted chain store.refold", () => {
		const ids = extractIdents("call store.refold() now");
		expect(ids).toContain("store.refold()");
	});

	it("extracts function call name", () => {
		const ids = extractIdents("call buildTickContext() now");
		expect(ids).toContain("buildtickcontext()");
	});

	it("extracts multi-level chain foo.bar.baz", () => {
		const ids = extractIdents("use foo.bar.baz");
		expect(ids).toContain("foo.bar.baz");
	});
});

describe("extractIdents — quoted strings", () => {
	it("extracts double-quoted string content", () => {
		const ids = extractIdents('read "sample-session.jsonl" file');
		expect(ids).toContain("sample-session.jsonl");
	});

	it("extracts single-quoted string content", () => {
		const ids = extractIdents("key is 'protectTokens' here");
		expect(ids).toContain("protecttokens");
	});

	it("ignores quoted strings shorter than 3 chars", () => {
		const ids = extractIdents('key "ab" is short');
		expect(ids).not.toContain("ab");
	});

	it("ignores quoted strings longer than 60 chars", () => {
		const long = "a".repeat(61);
		const ids = extractIdents(`key "${long}" is long`);
		expect(ids).not.toContain(long.toLowerCase());
	});
});

describe("extractIdents — hex/uuid/numbers", () => {
	it("extracts UUID-like id", () => {
		const ids = extractIdents("block 550e8400-e29b-41d4-a716-446655440000 is here");
		expect(ids).toContain("550e8400-e29b-41d4-a716-446655440000");
	});

	it("extracts 0x hex literal", () => {
		const ids = extractIdents("value 0x1f2a is hex");
		expect(ids).toContain("0x1f2a");
	});

	it("extracts number with unit suffix", () => {
		const ids = extractIdents("budget 20k tokens");
		expect(ids).toContain("20k");
	});

	it("extracts 4+ digit numbers", () => {
		const ids = extractIdents("port 1420 is used");
		expect(ids).toContain("1420");
	});

	it("does not extract short plain numbers < 4 digits", () => {
		const ids = extractIdents("value is 42 here");
		expect(ids).not.toContain("42");
	});
});

describe("extractIdents — lowercasing and deduplication", () => {
	it("lowercases all idents", () => {
		const ids = extractIdents("AccordionStore appendBlocks");
		expect(ids).not.toContain("AccordionStore");
		expect(ids).toContain("accordionstore");
		expect(ids).not.toContain("appendBlocks");
		expect(ids).toContain("appendblocks");
	});

	it("deduplicates identical idents", () => {
		const ids = extractIdents("AccordionStore AccordionStore accordionStore");
		const count = ids.filter((x) => x === "accordionstore").length;
		expect(count).toBe(1);
	});

	it("returns an array (not a Set)", () => {
		const ids = extractIdents("hello world");
		expect(Array.isArray(ids)).toBe(true);
	});
});

describe("identCounts", () => {
	it("counts how many blocks contain each ident", () => {
		const blocks: Block[] = [
			blk("b0", "call appendBlocks here"),
			blk("b1", "appendBlocks is called again"),
			blk("b2", "unrelated content only"),
		];
		const counts = identCounts(blocks, 3);
		// "appendblocks" appears in blocks 0 and 1
		expect(counts.get("appendblocks")).toBe(2);
	});

	it("respects endBlock limit", () => {
		const blocks: Block[] = [
			blk("b0", "call appendBlocks"),
			blk("b1", "appendBlocks again"),
			blk("b2", "appendBlocks third"),
		];
		const counts = identCounts(blocks, 2); // only blocks 0 and 1
		expect(counts.get("appendblocks")).toBe(2);
	});

	it("returns empty map for empty blocks", () => {
		expect(identCounts([], 0).size).toBe(0);
	});

	it("counts each ident once per block (not per occurrence within a block)", () => {
		const blocks: Block[] = [
			blk("b0", "appendBlocks appendBlocks appendBlocks"),
		];
		const counts = identCounts(blocks, 1);
		// Even though it appears 3× in the text, identCounts counts distinct blocks
		expect(counts.get("appendblocks")).toBe(1);
	});
});
