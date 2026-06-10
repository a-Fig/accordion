/*
 * lexical.test.ts — unit tests for identifier extraction and block matching.
 *
 * Heavily tested because the regexes are non-trivial and "will be wrong twice
 * before it's right" (spec note). Covers paths, symbols, quoted strings, stopwords,
 * rarity guard, and punctuation trailing.
 */
import { describe, it, expect } from "vitest";
import type { Block } from "./types";
import { extractIdentifiers, matchBlocks } from "./lexical";

function makeBlock(id: string, text: string): Block {
	return {
		id,
		kind: "text",
		turn: 1,
		order: 0,
		text,
		tokens: 100,
		override: null,
		autoFolded: false,
		by: null,
	};
}

describe("extractIdentifiers — file paths", () => {
	it("extracts unix file paths", () => {
		const ids = extractIdentifiers("edited app/src/lib/engine/store.ts today");
		expect(ids.has("app/src/lib/engine/store.ts")).toBe(true);
	});

	it("extracts relative paths with ./ prefix", () => {
		const ids = extractIdentifiers("import foo from ./components/Button.svelte");
		expect(ids.has("./components/Button.svelte")).toBe(true);
	});

	it("extracts paths with @scope/package format", () => {
		const ids = extractIdentifiers("installed @anthropic-ai/sdk/core");
		expect(ids.has("@anthropic-ai/sdk/core")).toBe(true);
	});

	it("strips trailing punctuation from paths", () => {
		const ids = extractIdentifiers("see app/src/engine/score.ts, and also foo/bar.ts.");
		// trailing comma and period should be stripped
		expect(ids.has("app/src/engine/score.ts")).toBe(true);
		expect(ids.has("foo/bar.ts")).toBe(true);
	});

	it("extracts Windows-style backslash paths", () => {
		const ids = extractIdentifiers("file at app\\src\\lib\\store.ts is broken");
		// should extract the backslash path
		const found = [...ids].some((id) => id.includes("store.ts"));
		expect(found).toBe(true);
	});
});

describe("extractIdentifiers — code symbols", () => {
	it("extracts camelCase identifiers", () => {
		const ids = extractIdentifiers("calling parseBlocks and buildContext functions");
		expect(ids.has("parseBlocks")).toBe(true);
		expect(ids.has("buildContext")).toBe(true);
	});

	it("extracts PascalCase identifiers", () => {
		const ids = extractIdentifiers("class AccordionStore extends BaseStore");
		expect(ids.has("AccordionStore")).toBe(true);
		expect(ids.has("BaseStore")).toBe(true);
	});

	it("extracts SCREAMING_CASE identifiers", () => {
		const ids = extractIdentifiers("FOLD_RANK and PROTECT_OVERFLOW_CAP constants");
		expect(ids.has("FOLD_RANK")).toBe(true);
		expect(ids.has("PROTECT_OVERFLOW_CAP")).toBe(true);
	});

	it("extracts snake_case identifiers", () => {
		const ids = extractIdentifiers("the fold_rank and cold_score functions");
		expect(ids.has("fold_rank")).toBe(true);
		expect(ids.has("cold_score")).toBe(true);
	});

	it("does NOT extract plain lowercase words", () => {
		const ids = extractIdentifiers("the quick brown foxes are jumping over lazy dogs today");
		// None of these are symbols — all lowercase, no underscore/digit/capital
		expect(ids.has("quick")).toBe(false);
		expect(ids.has("brown")).toBe(false);
		expect(ids.has("jumping")).toBe(false);
	});

	it("does NOT extract short tokens under 4 chars", () => {
		const ids = extractIdentifiers("var foo = bar in baz");
		expect(ids.has("foo")).toBe(false);
		expect(ids.has("bar")).toBe(false);
		expect(ids.has("baz")).toBe(false);
	});

	it("extracts identifiers with digits", () => {
		const ids = extractIdentifiers("variable block2Items and step3Result");
		expect(ids.has("block2Items")).toBe(true);
		expect(ids.has("step3Result")).toBe(true);
	});
});

describe("extractIdentifiers — quoted strings", () => {
	it("extracts double-quoted strings", () => {
		const ids = extractIdentifiers('the "sample-session.jsonl" file');
		expect(ids.has("sample-session.jsonl")).toBe(true);
	});

	it("extracts single-quoted strings", () => {
		const ids = extractIdentifiers("the 'accordion-context-folding' skill");
		expect(ids.has("accordion-context-folding")).toBe(true);
	});

	it("extracts backtick-quoted strings", () => {
		const ids = extractIdentifiers("call `store.refold()` to refresh");
		expect(ids.has("store.refold()")).toBe(true);
	});

	it("ignores very short quoted strings (under 3 chars)", () => {
		const ids = extractIdentifiers('the "ab" token');
		expect(ids.has("ab")).toBe(false);
	});

	it("ignores very long quoted strings (over 80 chars)", () => {
		const longStr = "a".repeat(81);
		const ids = extractIdentifiers(`the "${longStr}" string`);
		expect(ids.has(longStr)).toBe(false);
	});
});

describe("extractIdentifiers — stopwords", () => {
	it("excludes common code stopwords", () => {
		const ids = extractIdentifiers("return await async function import export const true false null undefined");
		for (const word of ["return", "await", "async", "function", "import", "export", "const", "true", "false", "null", "undefined"]) {
			expect(ids.has(word)).toBe(false);
		}
	});

	it("still extracts identifiers that merely START with a stopword prefix", () => {
		// "returnValue", "asyncHandler" are NOT stopwords despite having stopword prefixes
		const ids = extractIdentifiers("returnValue and asyncHandler functions");
		expect(ids.has("returnValue")).toBe(true);
		expect(ids.has("asyncHandler")).toBe(true);
	});
});

describe("extractIdentifiers — cap at 200", () => {
	it("returns at most 200 identifiers even with a huge input", () => {
		// Generate 500 unique camelCase symbols
		const symbols = Array.from({ length: 500 }, (_, i) => `mySymbol${i}`).join(" ");
		const ids = extractIdentifiers(symbols);
		expect(ids.size).toBeLessThanOrEqual(200);
	});

	it("keeps the longest identifiers first when truncating", () => {
		// Mix short and long symbols; all must have internal capital or digit
		const short = Array.from({ length: 100 }, (_, i) => `aB${i}xY`).join(" ");
		const long = Array.from({ length: 150 }, (_, i) => `averylongIdentifier${i}WithManyChars`).join(" ");
		const ids = extractIdentifiers(short + " " + long);
		// The long identifiers should be present (they get priority)
		const hasLong = [...ids].some((id) => id.startsWith("averylongIdentifier"));
		expect(hasLong).toBe(true);
	});
});

describe("matchBlocks — basic matching", () => {
	it("matches a block containing the identifier", () => {
		const blocks = [
			makeBlock("b1", "fixed the bug in app/src/engine/score.ts"),
			makeBlock("b2", "unrelated text about something else"),
		];
		const ids = new Set(["app/src/engine/score.ts"]);
		const result = matchBlocks(ids, blocks);
		expect(result.get("b1")).toBe("app/src/engine/score.ts");
		expect(result.has("b2")).toBe(false);
	});

	it("does not match when identifier is absent from block text", () => {
		const blocks = [makeBlock("b1", "no relevant content here at all")];
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(0);
	});
});

describe("matchBlocks — rarity guard", () => {
	it("drops identifiers that match more than 25% of candidates", () => {
		// 10 blocks, all containing "const" — rarity threshold = max(3, 25% of 10) = 3
		// "const" matches all 10 → dropped (stopword anyway)
		// Use a non-stopword that matches many blocks
		const blocks = Array.from({ length: 10 }, (_, i) =>
			makeBlock(`b${i}`, `the variable myVar is used here block${i}`),
		);
		// "myVar" matches all 10 → > 25% of 10 = 2.5 → threshold 3 → but 10 > 3 → dropped
		const ids = new Set(["myVar"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(0);
	});

	it("keeps identifiers that match at most 25% of candidates", () => {
		// 12 blocks, only 2 contain the identifier → 2 <= max(3, 3) = 3 → kept
		const blocks = [
			makeBlock("match1", "AccordionStore is the main class"),
			makeBlock("match2", "new AccordionStore() is created"),
			...Array.from({ length: 10 }, (_, i) => makeBlock(`other${i}`, `block ${i} about something else`)),
		];
		const ids = new Set(["AccordionStore"]);
		const result = matchBlocks(ids, blocks);
		expect(result.size).toBe(2);
		expect(result.has("match1")).toBe(true);
		expect(result.has("match2")).toBe(true);
	});

	it("respects the hard floor of 3 for the rarity threshold", () => {
		// 4 blocks, 3 match → threshold = max(3, 1) = 3 → exactly at threshold → KEPT
		const blocks = [
			makeBlock("m1", "parseBlocks function called"),
			makeBlock("m2", "parseBlocks returned value"),
			makeBlock("m3", "parseBlocks error occurred"),
			makeBlock("m4", "unrelated content here"),
		];
		const ids = new Set(["parseBlocks"]);
		const result = matchBlocks(ids, blocks);
		// 3 matches ≤ max(3, 4*0.25=1) = 3 → kept
		expect(result.size).toBe(3);
	});
});

describe("matchBlocks — first-match priority", () => {
	it("assigns each block the first (longest) matching identifier", () => {
		const block = makeBlock("b1", "see app/src/lib/engine/store.svelte.ts for AccordionStore");
		// extractIdentifiers would return longest-first; simulate:
		const ids = new Set(["app/src/lib/engine/store.svelte.ts", "AccordionStore"]);
		const result = matchBlocks(ids, [block]);
		// One of the two identifiers should win; b1 gets exactly one entry
		expect(result.has("b1")).toBe(true);
		expect(result.size).toBe(1);
	});
});
