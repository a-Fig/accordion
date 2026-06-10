/**
 * llm.test.ts — unit tests for the LLM layer (no network).
 *
 * Covers:
 *   - summaryKey stability and uniqueness
 *   - parseCacheLines tolerance (bad JSON lines skipped)
 *   - summaryPrompt: verbatim-identifier instruction present + kind-specific framing
 *   - SummaryCacheMem get/put
 */

import { describe, it, expect } from "vitest";
import { summaryKey, parseCacheLines, serializeEntry, SummaryCacheMem } from "../engine/summaryCache";
import { summaryPrompt, PROMPT_VERSION } from "./prompts";
import type { CacheEntry } from "../engine/summaryCache";

// ── summaryKey ────────────────────────────────────────────────────────────────

describe("summaryKey", () => {
	it("returns a 64-char hex string", async () => {
		const key = await summaryKey({ text: "hello", kind: "text", promptVersion: 1, model: "m" });
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is stable — same inputs produce the same key", async () => {
		const input = { text: "fix the bug", kind: "tool_result", promptVersion: 1, model: "gemini-2.5-flash-lite" };
		const a = await summaryKey(input);
		const b = await summaryKey(input);
		expect(a).toBe(b);
	});

	it("changes when text changes", async () => {
		const base = { text: "aaa", kind: "text", promptVersion: 1, model: "m" };
		const a = await summaryKey(base);
		const b = await summaryKey({ ...base, text: "bbb" });
		expect(a).not.toBe(b);
	});

	it("changes when kind changes", async () => {
		const base = { text: "same", kind: "text", promptVersion: 1, model: "m" };
		const a = await summaryKey(base);
		const b = await summaryKey({ ...base, kind: "thinking" });
		expect(a).not.toBe(b);
	});

	it("changes when promptVersion changes", async () => {
		const base = { text: "same", kind: "text", promptVersion: 1, model: "m" };
		const a = await summaryKey(base);
		const b = await summaryKey({ ...base, promptVersion: 2 });
		expect(a).not.toBe(b);
	});

	it("changes when model changes", async () => {
		const base = { text: "same", kind: "text", promptVersion: 1, model: "model-a" };
		const a = await summaryKey(base);
		const b = await summaryKey({ ...base, model: "model-b" });
		expect(a).not.toBe(b);
	});
});

// ── parseCacheLines ───────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
	return {
		key: "abc123",
		summary: "did a thing",
		kind: "text",
		model: "gemini-2.5-flash-lite",
		promptVersion: 1,
		srcTokens: 500,
		sumTokens: 30,
		at: Date.now(),
		...overrides,
	};
}

describe("parseCacheLines", () => {
	it("parses valid JSONL entries", () => {
		const e = makeEntry();
		const lines = serializeEntry(e);
		const parsed = parseCacheLines(lines);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].key).toBe(e.key);
		expect(parsed[0].summary).toBe(e.summary);
	});

	it("skips empty lines", () => {
		const e = makeEntry();
		const text = "\n" + serializeEntry(e) + "\n\n";
		const parsed = parseCacheLines(text);
		expect(parsed).toHaveLength(1);
	});

	it("skips lines with invalid JSON", () => {
		const e = makeEntry();
		const text = [
			"not-valid-json!!!",
			serializeEntry(e),
			"{broken",
		].join("\n");
		const parsed = parseCacheLines(text);
		expect(parsed).toHaveLength(1);
	});

	it("skips lines with valid JSON but missing required fields", () => {
		const e = makeEntry();
		const text = [
			JSON.stringify({ key: "abc", summary: "missing other fields" }), // invalid entry
			serializeEntry(e),
		].join("\n");
		const parsed = parseCacheLines(text);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].key).toBe(e.key);
	});

	it("handles an entirely empty string", () => {
		expect(parseCacheLines("")).toEqual([]);
	});

	it("handles multiple valid entries", () => {
		const entries = [makeEntry({ key: "k1" }), makeEntry({ key: "k2" }), makeEntry({ key: "k3" })];
		const text = entries.map(serializeEntry).join("\n");
		const parsed = parseCacheLines(text);
		expect(parsed).toHaveLength(3);
		expect(parsed.map((e) => e.key)).toEqual(["k1", "k2", "k3"]);
	});
});

// ── SummaryCacheMem ───────────────────────────────────────────────────────────

describe("SummaryCacheMem", () => {
	it("starts empty", () => {
		const c = new SummaryCacheMem();
		expect(c.size).toBe(0);
	});

	it("put then get returns the entry", () => {
		const c = new SummaryCacheMem();
		const e = makeEntry({ key: "testkey", summary: "the answer is 42" });
		c.put(e);
		const hit = c.get("testkey");
		expect(hit).toBeDefined();
		expect(hit?.summary).toBe("the answer is 42");
	});

	it("get returns undefined on miss", () => {
		const c = new SummaryCacheMem();
		expect(c.get("nonexistent")).toBeUndefined();
	});

	it("later put overwrites earlier entry with same key", () => {
		const c = new SummaryCacheMem();
		c.put(makeEntry({ key: "k", summary: "first" }));
		c.put(makeEntry({ key: "k", summary: "second" }));
		expect(c.get("k")?.summary).toBe("second");
		expect(c.size).toBe(1);
	});

	it("load populates from an array", () => {
		const c = new SummaryCacheMem();
		c.load([makeEntry({ key: "a" }), makeEntry({ key: "b" }), makeEntry({ key: "c" })]);
		expect(c.size).toBe(3);
		expect(c.get("b")).toBeDefined();
	});

	it("load later entry wins on key collision", () => {
		const c = new SummaryCacheMem();
		c.load([
			makeEntry({ key: "dup", summary: "first" }),
			makeEntry({ key: "dup", summary: "second" }),
		]);
		expect(c.get("dup")?.summary).toBe("second");
		expect(c.size).toBe(1);
	});
});

// ── summaryPrompt ─────────────────────────────────────────────────────────────

describe("summaryPrompt", () => {
	it("includes verbatim-identifier instruction in system prompt", () => {
		for (const kind of ["text", "thinking", "tool_result"] as const) {
			const { system } = summaryPrompt(kind, "some text");
			// Must instruct to preserve paths, identifiers, quoted strings, errors.
			expect(system).toMatch(/VERBATIM/i);
			expect(system).toMatch(/file path|identifier/i);
			expect(system).toMatch(/quoted string/i);
		}
	});

	it("tool_result prompt mentions what was asked and what came back", () => {
		const { system } = summaryPrompt("tool_result", "output here", "read_file");
		expect(system).toMatch(/what was asked/i);
		expect(system).toMatch(/what came back/i);
		expect(system).toContain("read_file");
	});

	it("thinking prompt mentions decisions and why", () => {
		const { system } = summaryPrompt("thinking", "reasoning here");
		expect(system).toMatch(/decisions/i);
	});

	it("text prompt mentions claims, commitments, answers", () => {
		const { system } = summaryPrompt("text", "reply here");
		expect(system).toMatch(/claims/i);
	});

	it("passes blockText through as user prompt (short input)", () => {
		const { user } = summaryPrompt("text", "short input");
		expect(user).toBe("short input");
	});

	it("truncates very long input with a marker", () => {
		const long = "x".repeat(30_000);
		const { user } = summaryPrompt("text", long);
		expect(user.length).toBeLessThan(long.length);
		expect(user).toContain("truncated");
	});

	it("produces a positive maxOutputTokens", () => {
		const { maxOutputTokens } = summaryPrompt("text", "hello");
		expect(maxOutputTokens).toBeGreaterThan(0);
	});

	it("PROMPT_VERSION is a number", () => {
		expect(typeof PROMPT_VERSION).toBe("number");
		expect(PROMPT_VERSION).toBeGreaterThan(0);
	});
});
