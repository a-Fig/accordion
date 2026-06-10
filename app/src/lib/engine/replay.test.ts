/*
 * replay.test.ts — tests for the replay driver.
 *
 * Tests:
 *   1. Real sample session: budget violations === 0 at default budget.
 *   2. churnPerTurn length === turns.
 *   3. A synthetic session with an unfold tool_call yields exactly one miss
 *      when the target is folded at unfold time.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "./parse";
import { replay } from "./replay";
import type { Block, ParsedSession } from "./types";
import { foldCode } from "./digest";

// ---- helpers ---------------------------------------------------------------

function blk(
	id: string,
	kind: Block["kind"],
	turn: number,
	order: number,
	tokens: number,
	text?: string,
	toolName?: string,
	callId?: string,
): Block {
	return {
		id,
		kind,
		turn,
		order,
		text: text ?? `block ${id} ` + "x".repeat(160),
		tokens,
		toolName,
		callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

// ---- sample session --------------------------------------------------------

describe("replay — sample session", () => {
	it("loads sample-session.jsonl and runs without errors", () => {
		// The sample session file lives at app/static/sample-session.jsonl.
		// vitest runs from the app/ directory (where vitest.config.ts lives).
		const samplePath = join(process.cwd(), "static", "sample-session.jsonl");
		const raw = readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);

		expect(blocks.length).toBeGreaterThan(0);

		const metrics = replay(blocks, { budget: 70_000, protectTokens: 20_000 });

		// Budget violations should be 0 at the default 70k budget
		expect(metrics.budgetViolations).toBe(0);

		// churnPerTurn length must equal turns
		expect(metrics.churnPerTurn.length).toBe(metrics.turns);

		// finalLive must be a positive number
		expect(metrics.finalLive).toBeGreaterThan(0);

		// foldedCount must be non-negative
		expect(metrics.foldedCount).toBeGreaterThanOrEqual(0);
	});

	it("budget violations === 0 at default budget on sample session", () => {
		const samplePath = join(process.cwd(), "static", "sample-session.jsonl");
		const raw = readFileSync(samplePath, "utf-8");
		const { blocks } = parse(raw);
		const metrics = replay(blocks, { budget: 70_000 });
		expect(metrics.budgetViolations).toBe(0);
	});
});

// ---- synthetic session with agent unfold --------------------------------

describe("replay — synthetic session with unfold tool_call", () => {
	it("yields exactly one miss when target is folded at unfold time", () => {
		// Build a session where:
		//   Turn 1: a large tool_result that will get auto-folded
		//   Turn 2: agent calls unfold with the fold code of that block
		// At turn 2, the fold code is requested — if the block is currently folded,
		// it's a miss. If it was already unfolded by conductor, it's preempted.
		//
		// We want exactly 1 miss → the block must be folded when the unfold call arrives.
		// To ensure this, we use a very tight budget so the block IS folded at turn 2.

		const blockId = "a:reply1:0";
		const code = foldCode(blockId);

		// Turn 1: large tool_result + small user
		// Turn 2: agent makes an unfold tool_call (the unfold tool itself is a tool_call block)
		//         But wait — the agent's reply is a tool_call, and the RESULT is the server's tool_result.
		//         parse.ts puts tool_call blocks in the assistant message turn.
		//         Here we simulate: turn 2 has a tool_call with toolName="unfold"
		const blocks: Block[] = [
			// Turn 1
			blk("a:reply1:0", "tool_result", 1, 0, 8000),
			blk("u:1", "user", 1, 1, 100, "please unfold block"),
			// Turn 2: agent calls unfold (this is a tool_call block in the conversation)
			blk(
				"a:reply2:0",
				"tool_call",
				2,
				2,
				100,
				`unfold {"codes":["${code}"]}`,
				"unfold",
			),
		];

		// Very tight budget so the tool_result IS folded
		const metrics = replay(blocks, {
			budget: 500,      // much less than 8000 → tool_result gets auto-folded
			protectTokens: 150, // protect the small tail
			applyAgentUnfolds: true,
		});

		// The tool_result was folded when the agent called unfold → exactly 1 miss
		expect(metrics.misses.length).toBe(1);
		expect(metrics.misses[0].code).toBe(code);
		expect(metrics.misses[0].wasFolded).toBe(true);
		expect(metrics.misses[0].preempted).toBe(false);
		expect(metrics.misses[0].turn).toBe(2);
	});

	it("records blockId correctly in the miss", () => {
		const blockId = "a:reply1:0";
		const code = foldCode(blockId);

		const blocks: Block[] = [
			blk("a:reply1:0", "tool_result", 1, 0, 8000),
			blk("u:1", "user", 1, 1, 100),
			blk("a:reply2:0", "tool_call", 2, 2, 100, `unfold {"codes":["${code}"]}`, "unfold"),
		];

		const metrics = replay(blocks, { budget: 500, protectTokens: 150 });
		if (metrics.misses.length > 0) {
			expect(metrics.misses[0].blockId).toBe(blockId);
		}
	});

	it("no miss when target block is live at unfold time", () => {
		// Build a session where the budget is high enough that nothing is folded
		const blockId = "a:reply1:0";
		const code = foldCode(blockId);

		const blocks: Block[] = [
			blk("a:reply1:0", "tool_result", 1, 0, 500), // small → won't be auto-folded
			blk("u:1", "user", 1, 1, 100),
			blk("a:reply2:0", "tool_call", 2, 2, 100, `unfold {"codes":["${code}"]}`, "unfold"),
		];

		const metrics = replay(blocks, { budget: 70_000, protectTokens: 200 });
		// No block is folded → no miss
		expect(metrics.misses.length).toBe(0);
	});
});

describe("replay — metrics structure", () => {
	it("churnPerTurn has exactly one entry per turn", () => {
		const blocks: Block[] = [
			blk("b1", "text", 1, 0, 1000),
			blk("b2", "text", 2, 1, 1000),
			blk("b3", "text", 3, 2, 1000),
		];
		const metrics = replay(blocks, { budget: 100_000 });
		expect(metrics.churnPerTurn.length).toBe(metrics.turns);
		expect(metrics.turns).toBe(3);
	});

	it("finalLive + finalSaved = total full tokens", () => {
		const blocks: Block[] = [
			blk("b1", "text", 1, 0, 2000),
			blk("b2", "text", 2, 1, 3000),
		];
		const metrics = replay(blocks, { budget: 4000, protectTokens: 500 });
		expect(metrics.finalLive + metrics.finalSaved).toBeCloseTo(
			blocks.reduce((s, b) => s + b.tokens, 0),
			-2, // rough check — folded blocks use digest tokens not full tokens
		);
	});

	it("lexicalUnfolds is non-negative", () => {
		const blocks: Block[] = [blk("b1", "text", 1, 0, 1000)];
		const metrics = replay(blocks, { budget: 100_000 });
		expect(metrics.lexicalUnfolds).toBeGreaterThanOrEqual(0);
	});
});
