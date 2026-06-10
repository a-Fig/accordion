/*
 * coalesce.guard.test.ts — regression tests for the budget-violation bug the corpus
 * eval caught: coalescing must never separate a tool pair (in EITHER direction) and
 * a conductor group must never increase live cost.
 *
 * Mechanisms pinned:
 *  1. Pass 2: a folded tool_result whose CALL exists outside the run is excluded
 *     (it would become a FULL-cost straggler inside a folded group).
 *  2. Pass 3: a chunk boundary never splits multi-call pairs (call1,call2,res1 | res2).
 *  3. Corpus-wide: replaying every local corpus session under eval settings produces
 *     zero budget violations (opt-in — skipped when ~/.accordion/corpus is absent).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findCoalesceRuns, COALESCE_CONFIG } from "./coalesce";
import { replay } from "./replay";
import { parse } from "./parse";
import type { Block } from "./types";

function blk(
	id: string,
	kind: Block["kind"] = "text",
	turn = 1,
	order = 0,
	tokens = 1000,
	opts: Partial<Pick<Block, "override" | "autoFolded" | "by" | "callId">> = {},
): Block {
	return {
		id,
		kind,
		turn,
		order,
		text: `block ${id} ` + "x".repeat(200),
		tokens,
		override: opts.override ?? null,
		autoFolded: opts.autoFolded ?? false,
		by: opts.by ?? null,
		callId: opts.callId,
	};
}

const cold = (b: Block): Block => ({ ...b, autoFolded: true, override: null, by: "auto" });

/** findCoalesceRuns with permissive adapters over a plain block list. */
function runsOf(blocks: Block[], currentTurn: number) {
	return findCoalesceRuns({
		blocks,
		protectedFromIndex: blocks.length,
		currentTurn,
		inGroup: () => false,
		isAutoFolded: (b) => b.override === null && b.autoFolded,
		groupCoolActive: () => false,
	});
}

/** Index range [start..end] of a run within the block list. */
function rangeOf(blocks: Block[], run: { startId: string; endId: string }): [number, number] {
	const s = blocks.findIndex((b) => b.id === run.startId);
	const e = blocks.findIndex((b) => b.id === run.endId);
	return [s, e];
}

/** Assert every run is tool-pair balanced against the whole session. */
function assertRunsBalanced(blocks: Block[], runs: { startId: string; endId: string }[]) {
	const sessionCalls = new Set(blocks.filter((b) => b.kind === "tool_call" && b.callId).map((b) => b.callId));
	for (const run of runs) {
		const [s, e] = rangeOf(blocks, run);
		const members = blocks.slice(s, e + 1);
		const calls = new Set(members.filter((b) => b.kind === "tool_call" && b.callId).map((b) => b.callId));
		const results = new Set(members.filter((b) => b.kind === "tool_result" && b.callId).map((b) => b.callId));
		for (const id of calls) expect(results.has(id), `call ${id} without result in run`).toBe(true);
		for (const id of results) {
			if (sessionCalls.has(id)) expect(calls.has(id), `result ${id} split from its call`).toBe(true);
		}
	}
}

describe("coalesce pair integrity (budget-violation regression)", () => {
	it("excludes a folded tool_result whose call lives outside the run", () => {
		const T = 100;
		let order = 0;
		const blocks: Block[] = [];
		// Episode A: a tool_call whose RESULT lands in episode B (cross-seam pair)
		blocks.push(blk("u:1", "user", 1, order++, 100));
		blocks.push(blk("tc:x", "tool_call", 1, order++, 50, { callId: "X" }));
		// seam
		blocks.push(blk("u:2", "user", 2, order++, 100));
		// Episode B: the orphan result + plenty of cold blocks (>= minRun without it)
		blocks.push(cold(blk("tr:x", "tool_result", 2, order++, 3000, { callId: "X" })));
		for (let i = 0; i < COALESCE_CONFIG.minRun + 2; i++) {
			blocks.push(cold(blk(`t:${i}`, "text", 2, order++, 500)));
		}
		const runs = runsOf(blocks, T);
		expect(runs.length).toBeGreaterThan(0);
		const trIdx = blocks.findIndex((b) => b.id === "tr:x");
		for (const run of runs) {
			const [s, e] = rangeOf(blocks, run);
			expect(trIdx < s || trIdx > e, "orphan result must not be inside any run").toBe(true);
		}
		assertRunsBalanced(blocks, runs);
	});

	it("keeps a tool_result with NO call anywhere (compaction-style) inside runs", () => {
		const T = 100;
		let order = 0;
		const blocks: Block[] = [blk("u:1", "user", 1, order++, 100)];
		blocks.push(cold(blk("tr:lone", "tool_result", 1, order++, 800, { callId: "GONE" })));
		for (let i = 0; i < COALESCE_CONFIG.minRun; i++) blocks.push(cold(blk(`t:${i}`, "text", 1, order++, 500)));
		const runs = runsOf(blocks, T);
		expect(runs.length).toBe(1);
		const [s, e] = rangeOf(blocks, runs[0]);
		const trIdx = blocks.findIndex((b) => b.id === "tr:lone");
		expect(trIdx >= s && trIdx <= e).toBe(true);
	});

	it("never splits multi-call pairs at a chunk boundary (call1,call2,res1 | res2)", () => {
		const T = 100;
		let order = 0;
		const blocks: Block[] = [blk("u:1", "user", 1, order++, 100)];
		// 9 cold texts, then call A, call B, result A, result B — maxMembers (12)
		// would land the boundary between result A and result B without the trim.
		for (let i = 0; i < 9; i++) blocks.push(cold(blk(`t:${i}`, "text", 1, order++, 200)));
		blocks.push(blk("tc:a", "tool_call", 1, order++, 50, { callId: "A" }));
		blocks.push(blk("tc:b", "tool_call", 1, order++, 50, { callId: "B" }));
		blocks.push(cold(blk("tr:a", "tool_result", 1, order++, 400, { callId: "A" })));
		blocks.push(cold(blk("tr:b", "tool_result", 1, order++, 400, { callId: "B" })));
		// More cold texts after, so a second chunk is plausible
		for (let i = 9; i < 14; i++) blocks.push(cold(blk(`t:${i}`, "text", 1, order++, 200)));
		const runs = runsOf(blocks, T);
		assertRunsBalanced(blocks, runs);
	});

	it("token-cap chunking also stays pair-balanced", () => {
		const T = 100;
		let order = 0;
		const blocks: Block[] = [blk("u:1", "user", 1, order++, 100)];
		// Big cold blocks so maxFullTokens forces chunk splits at awkward places
		for (let i = 0; i < 8; i++) blocks.push(cold(blk(`t:${i}`, "text", 1, order++, 1800)));
		blocks.push(blk("tc:a", "tool_call", 1, order++, 100, { callId: "A" }));
		blocks.push(blk("tc:b", "tool_call", 1, order++, 100, { callId: "B" }));
		blocks.push(cold(blk("tr:a", "tool_result", 1, order++, 1800, { callId: "A" })));
		blocks.push(cold(blk("tr:b", "tool_result", 1, order++, 1800, { callId: "B" })));
		for (let i = 8; i < 20; i++) blocks.push(cold(blk(`t:${i}`, "text", 1, order++, 1800)));
		assertRunsBalanced(blocks, runsOf(blocks, T));
	});
});

describe("corpus replay budget invariant (opt-in)", () => {
	const corpusDir = join(homedir(), ".accordion", "corpus");
	const has = existsSync(corpusDir);
	it.skipIf(!has)("no budget violations on any corpus session under eval settings", () => {
		const files = readdirSync(corpusDir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			let parsed;
			try {
				parsed = parse(readFileSync(join(corpusDir, f), "utf8"));
			} catch {
				continue; // unparseable session — not this test's concern
			}
			if (!parsed.blocks.length) continue;
			const full = parsed.blocks.reduce((n, b) => n + b.tokens, 0);
			const budget = Math.min(70_000, Math.max(8_000, Math.round(full * 0.55)));
			const protect = Math.min(20_000, Math.round(full * 0.25));
			// A single block larger than the whole budget makes a violation
			// mathematically unavoidable (the newest block is always protected,
			// and user/tool_call blocks never fold) — not a conductor defect.
			const maxBlock = parsed.blocks.reduce((n, b) => Math.max(n, b.tokens), 0);
			if (maxBlock > budget) continue;
			const m = replay(parsed.blocks, { budget, protectTokens: protect });
			expect(m.budgetViolations, `budget violations in ${f}`).toBe(0);
		}
	}, 120_000);
});
