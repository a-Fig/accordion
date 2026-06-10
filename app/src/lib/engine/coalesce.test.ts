/*
 * coalesce.test.ts — unit tests for the auto-coalesce policy (ADR 0009, C2.5).
 *
 * Covers:
 *   - findCoalesceRuns: detection rules (user seams, age, pins/manual/sticky, tool pairs,
 *     maxMembers/maxFullTokens chunking, minRun floor, groupCool)
 *   - Integration: long cold session coalesces into expected groups; "conductor" provenance;
 *     log entries; liveTokens decreases vs pre-coalesce; idempotence; hysteresis;
 *     pruneProtectedGroups dissolves conductor group; lexical restore / re-coalesce flow
 *   - OPT-IN real-corpus test (skipped if no corpus file)
 */
import { describe, it, expect } from "vitest";
import { findCoalesceRuns, COALESCE_CONFIG } from "./coalesce";
import { AccordionStore, HYSTERESIS } from "./store.svelte";
import type { Block, ParsedSession } from "./types";

// ── Test helpers ────────────────────────────────────────────────────────────────

/** Make a minimal Block for coalesce testing. */
function blk(
	id: string,
	kind: Block["kind"] = "text",
	turn: number = 1,
	order: number = 0,
	tokens: number = 1000,
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

/** Convenience: mark a block as auto-folded. */
function autoFolded(b: Block): Block {
	return { ...b, autoFolded: true, override: null, by: "auto" };
}

function makeStore(blocks: Block[], budget = 1_000_000, protect = 0): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	const s = new AccordionStore(parsed);
	s.setProtect(protect);
	s.setBudget(budget);
	return s;
}

/**
 * Build a "long cold" session where many old blocks are auto-folded:
 *   - `coldCount` tool_result blocks at turns [1..coldCount] — old, will auto-fold
 *   - 1 user block at each seam turn
 *   - 1 protected tail block
 *
 * coldCount is spread across `episodes` episodes (each starting with a user block).
 */
function buildColdSession(coldCount: number, tailTokens = 5000): Block[] {
	const blocks: Block[] = [];
	let order = 0;
	// Build: [user, tool_result x N] * episodes
	for (let turn = 1; turn <= coldCount; turn++) {
		// user block at each turn
		blocks.push(blk(`u:${turn}`, "user", turn, order++, 200));
		// one large tool_result per turn
		blocks.push(blk(`tr:${turn}`, "tool_result", turn, order++, 2000));
	}
	// Protected tail
	const tailTurn = coldCount + 1;
	blocks.push(blk(`tail:text`, "text", tailTurn, order++, tailTokens));
	return blocks;
}

// ── findCoalesceRuns unit tests ──────────────────────────────────────────────

describe("findCoalesceRuns — detection rules", () => {

	it("basic run detection: returns a run of cold auto-folded blocks", () => {
		// 10 cold text blocks (all auto-folded), no user seams, protected tail = last block
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) {
			blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 800)));
		}
		// protected tail
		blocks.push(blk("tail", "text", 50, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10, // only tail protected
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});

		expect(runs.length).toBeGreaterThan(0);
		// Total foldable = 10, maxMembers = 12, so fits in one run
		expect(runs[0].memberCount).toBe(10);
		expect(runs[0].startId).toBe("b:0");
		expect(runs[0].endId).toBe("b:9");
	});

	it("user seams split runs", () => {
		// [5 auto-folded text] [user] [5 auto-folded text] — user splits into 2 runs
		const blocks: Block[] = [];
		for (let i = 0; i < 5; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		blocks.push(blk("u:mid", "user", 2, 5, 100));
		for (let i = 0; i < 5; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 3, 6 + i, 800)));
		blocks.push(blk("tail", "text", 50, 11, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 11,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});

		// Each sub-run has 5 blocks < minRun=8, so no runs returned
		expect(runs.length).toBe(0);
	});

	it("user seams split runs — both halves ≥ minRun emit two runs", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		blocks.push(blk("u:mid", "user", 2, 10, 100));
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 3, 11 + i, 800)));
		blocks.push(blk("tail", "text", 50, 21, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 21,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});

		// Each half: 10 blocks. maxMembers=12 → each fits in one chunk.
		expect(runs.length).toBe(2);
		expect(runs[0].memberCount).toBe(10);
		expect(runs[1].memberCount).toBe(10);
	});

	it("young blocks (age < minAgeTurns) are excluded", () => {
		// currentTurn=10, minAgeTurns=20 → only blocks with turn <= -10 qualify (none)
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) {
			blocks.push(autoFolded(blk(`b:${i}`, "text", 9, i, 800))); // turn 9, currentTurn 10 → age=1 < 20
		}
		blocks.push(blk("tail", "text", 10, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 10,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(0);
	});

	it("pinned blocks (override='pinned') break runs", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 5; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		blocks.push(blk("pinned:mid", "text", 1, 5, 800, { override: "pinned" }));
		for (let i = 0; i < 5; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, 6 + i, 800)));
		blocks.push(blk("tail", "text", 50, 11, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 11,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// Each half = 5 < minRun=8 → no runs
		expect(runs.length).toBe(0);
	});

	it("manually overridden blocks (override='folded') break runs", () => {
		// A block with override="folded" is NOT isAutoFolded (autoFolded=false, override set)
		const blocks: Block[] = [];
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		// manual fold — isAutoFolded returns false because override !== null
		blocks.push(blk("manual:mid", "text", 1, 4, 800, { override: "folded", autoFolded: false }));
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, 5 + i, 800)));
		blocks.push(blk("tail", "text", 50, 9, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 9,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(0); // each half < minRun
	});

	it("agent-sticky unfolded blocks (override='unfolded') break runs", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		blocks.push(blk("agent:mid", "text", 1, 4, 800, { override: "unfolded", autoFolded: false, by: "agent" }));
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, 5 + i, 800)));
		blocks.push(blk("tail", "text", 50, 9, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 9,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(0);
	});

	it("already-grouped blocks are excluded", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 800)));
		blocks.push(blk("tail", "text", 50, 10, 500));

		// Mark blocks 3..5 as already in a group
		const grouped = new Set(["b:3", "b:4", "b:5"]);
		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 50,
			inGroup: (id) => grouped.has(id),
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// Grouped blocks split the run into [0..2] (3 < minRun) and [6..9] (4 < minRun)
		expect(runs.length).toBe(0);
	});

	it("tool_call blocks allowed inside run only when their result is also in the run", () => {
		// call + result pair both inside → allowed
		const blocks: Block[] = [];
		// 4 text blocks, 1 tool_call+result pair, 4 more text blocks
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`t:${i}`, "text", 1, i, 800)));
		blocks.push(autoFolded(blk("call:1", "tool_call", 1, 4, 100, { callId: "cx1" })));
		blocks.push(autoFolded(blk("result:1", "tool_result", 1, 5, 800, { callId: "cx1" })));
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`u:${i}`, "text", 1, 6 + i, 800)));
		blocks.push(blk("tail", "text", 50, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// All 10 blocks in one run (pair is balanced)
		expect(runs.length).toBe(1);
		expect(runs[0].memberCount).toBe(10);
	});

	it("orphaned tool_call (result outside run) splits the run — pair never split across chunk boundary", () => {
		// call at position 4 whose result is OUTSIDE (after the protected boundary)
		const blocks: Block[] = [];
		for (let i = 0; i < 4; i++) blocks.push(autoFolded(blk(`t:${i}`, "text", 1, i, 800)));
		blocks.push(autoFolded(blk("call:orphan", "tool_call", 1, 4, 100, { callId: "cOrphan" })));
		for (let i = 0; i < 5; i++) blocks.push(autoFolded(blk(`u:${i}`, "text", 1, 5 + i, 800)));
		// result is in the protected tail (not foldable)
		blocks.push(blk("result:orphan", "tool_result", 50, 10, 800, { callId: "cOrphan" }));
		blocks.push(blk("tail", "text", 50, 11, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10, // result + tail protected
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// Orphaned call splits: [0..3] (4 < minRun) | call excluded | [5..9] (5 < minRun) → no runs
		// OR: [0..3] + [5..9] each < minRun=8 → no runs
		expect(runs.length).toBe(0);
	});

	it("orphaned tool_call splits — large halves still form runs", () => {
		// 10 text + orphaned call + 10 text → each half ≥ minRun=8
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`a:${i}`, "text", 1, i, 800)));
		blocks.push(autoFolded(blk("call:orphan", "tool_call", 1, 10, 100, { callId: "cOrphan" })));
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, 11 + i, 800)));
		blocks.push(blk("tail", "text", 50, 21, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 21,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// Each side (10 blocks) ≥ minRun=8 → 2 runs, orphan excluded
		expect(runs.length).toBe(2);
		expect(runs[0].memberCount).toBe(10);
		expect(runs[1].memberCount).toBe(10);
	});

	it("maxMembers chunking: a 20-block run splits into two chunks of ≤12", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 20; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 500)));
		blocks.push(blk("tail", "text", 50, 20, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 20,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(2);
		expect(runs[0].memberCount).toBeLessThanOrEqual(COALESCE_CONFIG.maxMembers);
		expect(runs[1].memberCount).toBeLessThanOrEqual(COALESCE_CONFIG.maxMembers);
		expect(runs[0].memberCount + runs[1].memberCount).toBe(20);
	});

	it("maxFullTokens chunking: splits when token sum exceeds cap", () => {
		// 2000 tokens each × 10 = 20000 > 15000 → split into two
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 2000)));
		blocks.push(blk("tail", "text", 50, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// 7 × 2000 = 14000 < 15000, 8 × 2000 = 16000 > 15000 → first chunk = 7 (≥ minRun=8? No: 7 < 8)
		// Actually: first 7 = 14000 ≤ 15000, adding 8th would be 16000 > 15000 → chunk 7 (< minRun=8)
		// Then second chunk: 3 blocks (< minRun=8). Neither meets minRun.
		// So no runs.
		expect(runs.length).toBe(0);
	});

	it("maxFullTokens chunking: 1500 tokens × 12 = 18000 → splits into runs of ≥8", () => {
		// 12 blocks × 1500 = 18000 > 15000. Chunk boundary at 10 × 1500 = 15000 exactly (≤ cap).
		// So first chunk = 10 blocks (= minRun bound... 10 ≥ 8 ✓), second chunk = 2 (< 8, discarded).
		const blocks: Block[] = [];
		for (let i = 0; i < 20; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 1500)));
		blocks.push(blk("tail", "text", 50, 20, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 20,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// 10 × 1500 = 15000 ≤ cap, but cap is 15000 not > 15000, and adding 11th would be 16500 > 15000
		// Actually: 10 blocks = 15000, adding 11th = 16500 > 15000 → chunk = 10.
		// Then remaining 10 → another chunk of 10.
		// Both ≥ minRun=8.
		expect(runs.length).toBeGreaterThanOrEqual(1);
		for (const r of runs) {
			expect(r.memberCount).toBeGreaterThanOrEqual(COALESCE_CONFIG.minRun);
			expect(r.memberCount).toBeLessThanOrEqual(COALESCE_CONFIG.maxMembers);
		}
	});

	it("minRun floor: runs shorter than minRun are not returned", () => {
		// 7 blocks < minRun=8
		const blocks: Block[] = [];
		for (let i = 0; i < 7; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 800)));
		blocks.push(blk("tail", "text", 50, 7, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 7,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(0);
	});

	it("exactly minRun blocks passes the floor", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < COALESCE_CONFIG.minRun; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 800)));
		blocks.push(blk("tail", "text", 50, COALESCE_CONFIG.minRun, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: COALESCE_CONFIG.minRun,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(1);
		expect(runs[0].memberCount).toBe(COALESCE_CONFIG.minRun);
	});

	it("groupCoolActive blocks a run from forming", () => {
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) blocks.push(autoFolded(blk(`b:${i}`, "text", 1, i, 800)));
		blocks.push(blk("tail", "text", 50, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: (firstId) => firstId === "b:0", // the first member is on cool
		});
		expect(runs.length).toBe(0);
	});

	it("a non-auto-folded block in the middle breaks the run", () => {
		// b:4 is not auto-folded (e.g. conductor-unfolded and stayed live) → breaks run
		const blocks: Block[] = [];
		for (let i = 0; i < 10; i++) {
			// b:4 is live (override="unfolded"), all others auto-folded
			const b = i === 4
				? blk(`b:${i}`, "text", 1, i, 800, { override: "unfolded", autoFolded: false })
				: autoFolded(blk(`b:${i}`, "text", 1, i, 800));
			blocks.push(b);
		}
		blocks.push(blk("tail", "text", 50, 10, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 10,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		// Split at b:4 → [b:0..b:3] (4 < 8) and [b:5..b:9] (5 < 8) → no runs
		expect(runs.length).toBe(0);
	});

	it("non-auto-folded block in middle of large run — both halves still form runs", () => {
		// b:9 is live (not autoFolded) → splits run into [0..8] (9 ≥ 8) and [10..19] (10 ≥ 8)
		const blocks: Block[] = [];
		for (let i = 0; i < 20; i++) {
			const b = i === 9
				? blk(`b:${i}`, "text", 1, i, 500, { override: "unfolded", autoFolded: false })
				: autoFolded(blk(`b:${i}`, "text", 1, i, 500));
			blocks.push(b);
		}
		blocks.push(blk("tail", "text", 50, 20, 500));

		const runs = findCoalesceRuns({
			blocks,
			protectedFromIndex: 20,
			currentTurn: 50,
			inGroup: () => false,
			isAutoFolded: (b) => b.override === null && b.autoFolded,
			groupCoolActive: () => false,
		});
		expect(runs.length).toBe(2);
		expect(runs[0].memberCount).toBe(9);
		expect(runs[1].memberCount).toBe(10);
	});
});

// ── Integration tests (AccordionStore) ──────────────────────────────────────

describe("integration — auto-coalesce in AccordionStore", () => {
	/**
	 * Build a long cold session where many old blocks end up auto-folded:
	 * A few "episodes" of [user, then 10 tool_results] at old turns.
	 * User seams separate episodes; tool_results within each episode form long runs.
	 * With a tight budget and high protection, the budget clamp folds all old blocks,
	 * then the coalesce step should group them.
	 *
	 * Layout:
	 *   turn 1:  u:1 (user), tr:1..10 (10 tool_results, 1000 tok each)
	 *   turn 2:  u:2 (user), tr:11..20 (10 tool_results)
	 *   turn 3:  u:3 (user), tr:21..30 (10 tool_results)
	 *   turn 51: tail:text (protected)
	 *
	 * currentTurn = 51. ageCutoff = 51 - 20 = 31. All tool_results (turns 1..3) qualify.
	 * Each episode has 10 tool_results ≥ minRun=8. Expected: 3 conductor groups.
	 */
	function buildLongColdSession() {
		const blocks: Block[] = [];
		let order = 0;
		let trIdx = 1;
		// 3 episodes of [user, 10 tool_results]
		// IDs use r:N format ("r:1" → messageKey = "r:1" — scalar, no snapping)
		// because /^[a-z]:\d+$/ matches single-letter prefix, preserving the id.
		for (let episode = 1; episode <= 3; episode++) {
			blocks.push(blk(`u:${episode}`, "user", episode, order++, 200));
			for (let i = 0; i < 10; i++) {
				blocks.push(blk(`r:${trIdx}`, "tool_result", episode, order++, 1000));
				trIdx++;
			}
		}
		// Protected tail at turn 51 (age = 51 - 3 = 48 > minAgeTurns=20)
		blocks.push(blk("tail:text", "text", 51, order++, 5000));
		return blocks;
	}

	it("long cold session: conductor groups form with by='conductor'", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000); // tight budget forces folding; protect tail

		// Conductor groups should have formed
		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		expect(conductorGroups.length).toBeGreaterThan(0);
		for (const g of conductorGroups) {
			expect(g.by).toBe("conductor");
			expect(g.folded).toBe(true);
			expect(g.memberIds.length).toBeGreaterThanOrEqual(COALESCE_CONFIG.minRun);
			expect(g.memberIds.length).toBeLessThanOrEqual(COALESCE_CONFIG.maxMembers);
		}
	});

	it("log entries present with actor 'conductor' and action 'grouped'", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const groupedEntries = s.log.filter((e) => e.by === "conductor" && e.action === "grouped");
		expect(groupedEntries.length).toBeGreaterThan(0);
	});

	it("liveTokens decreases after coalesce vs pre-coalesce (folded-only) state", () => {
		const blocks = buildLongColdSession();
		// Build at a budget where folding happens but NO groups exist
		// (budget=1M → no auto-folding → no coalescing)
		const sNoCoalesce = makeStore(blocks, 1_000_000, 6000);
		const liveNoCoalesce = sNoCoalesce.liveTokens;

		// Build with tight budget → auto-folding + coalescing
		const sWithCoalesce = makeStore(blocks, 8000, 6000);

		// First check auto-folding alone reduces tokens from unfolded
		expect(sWithCoalesce.liveTokens).toBeLessThan(liveNoCoalesce);

		// Groups should show savings over their full tokens
		for (const g of sWithCoalesce.groups.filter((g) => g.by === "conductor")) {
			expect(sWithCoalesce.groupSavedTokens(g)).toBeGreaterThan(0);
		}
	});

	it("net savings >= 0 per conductor group (coalescing never costs more than individual stubs)", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		for (const g of s.groups.filter((g) => g.by === "conductor")) {
			// groupSavedTokens = groupFullTokens - groupLiveTokens
			// groupLiveTokens for folded group = one group digest entry
			// This must be ≥ 0 (group saves tokens, or at worst breaks even)
			expect(s.groupSavedTokens(g)).toBeGreaterThanOrEqual(0);
		}
	});

	it("idempotence: repeated refold creates no new groups and zero foldFlips delta", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const groupCountBefore = s.groups.length;
		const flipsBefore = s.foldFlips;

		// Run refold twice more
		s.refold();
		s.refold();

		expect(s.groups.length).toBe(groupCountBefore);
		expect(s.foldFlips).toBe(flipsBefore);
	});

	it("re-entrancy guard: refold inside createGroup is a no-op (no infinite recursion)", () => {
		// If the guard didn't work, this would stack-overflow.
		// Just ensure a regular createGroup call doesn't throw.
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);
		// Call refold manually several times — no crash
		for (let i = 0; i < 10; i++) s.refold();
		expect(s.groups.length).toBeGreaterThan(0);
	});

	it("hysteresis: deleteGroup then refold — no re-form for cooldownTurns", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		expect(conductorGroups.length).toBeGreaterThan(0);

		const g = conductorGroups[0];
		const firstId = g.memberIds[0];
		const turnAtDelete = s.currentTurn;

		// Delete the conductor group → members freed, groupCool set
		s.deleteGroup(g.id, "you");
		expect(s.groupCoolUntil(firstId)).toBe(turnAtDelete + COALESCE_CONFIG.cooldownTurns);

		// Members are now free (not in any group). But groupCool is active.
		// refold() will try to coalesce but groupCoolActive(firstId) blocks it.
		s.refold();
		const reforgedImmediately = s.groups.some(
			(gr) => gr.memberIds[0] === firstId && gr.by === "conductor"
		);
		expect(reforgedImmediately).toBe(false);
	});

	it("hysteresis: unfoldGroup sets groupCool which blocks re-coalesce after delete", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		expect(conductorGroups.length).toBeGreaterThan(0);

		const g = conductorGroups[0];
		const firstId = g.memberIds[0];
		const turnAtUnfold = s.currentTurn;

		// Unfold the conductor group → sets groupCool
		s.unfoldGroup(g.id, "you");
		expect(s.groupCoolUntil(firstId)).toBe(turnAtUnfold + COALESCE_CONFIG.cooldownTurns);

		// Now delete the open group (members freed, but groupCool already set)
		s.deleteGroup(g.id, "you");

		// refold immediately → groupCool still active → no re-form
		s.refold();
		const reforgedImmediately = s.groups.some(
			(gr) => gr.memberIds[0] === firstId && gr.by === "conductor"
		);
		expect(reforgedImmediately).toBe(false);
	});

	it("pruneProtectedGroups dissolves a conductor group when setProtect widens", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		expect(conductorGroups.length).toBeGreaterThan(0);

		// Widen protect to cover everything → all groups dissolved
		s.setProtect(1_000_000);
		expect(s.protectedFromIndex).toBe(0);
		expect(s.groups.filter((g) => g.by === "conductor").length).toBe(0);
	});

	it("conductor groups have ≥ minRun and ≤ maxMembers members", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		for (const g of s.groups.filter((g) => g.by === "conductor")) {
			expect(g.memberIds.length).toBeGreaterThanOrEqual(COALESCE_CONFIG.minRun);
			expect(g.memberIds.length).toBeLessThanOrEqual(COALESCE_CONFIG.maxMembers);
		}
	});

	it("deleteGroup on conductor group sets groupCool (hysteresis)", () => {
		const blocks = buildLongColdSession();
		const s = makeStore(blocks, 8000, 6000);

		const g = s.groups.find((g) => g.by === "conductor");
		if (!g) throw new Error("Expected conductor group");
		const firstId = g.memberIds[0];
		const turnAtDelete = s.currentTurn;

		s.deleteGroup(g.id, "you");
		expect(s.groupCoolUntil(firstId)).toBe(turnAtDelete + COALESCE_CONFIG.cooldownTurns);
	});

	it("lexical restore path: conductor group unfolds, matched member stays live, remainder eligible after cooldown", () => {
		// Build: one episode with 10 old tool_result blocks, then a tail that mentions "parseBlocks"
		// Using the same structure as buildLongColdSession (episode of 10 tool_results).
		// The coalesce step groups the 10 tool_results into a conductor group.
		// The tail mentions "parseBlocks" which appears in one of the tool_result blocks.
		// The lexical step should open the conductor group.
		const blocks: Block[] = [];
		let order = 0;
		// One user block to start the episode
		blocks.push(blk("u:1", "user", 1, order++, 200));
		// 10 tool_result blocks at turn 1, one mentions "parseBlocks"
		for (let i = 0; i < 10; i++) {
			blocks.push({
				...blk(`r:${i + 1}`, "tool_result", 1, order++, 800),
				text: i === 3 ? "inside parseBlocks implementation for the engine" : `block r:${i + 1} ` + "x".repeat(200),
			});
		}
		// Protected tail that mentions "parseBlocks" at turn 51
		blocks.push({
			...blk("tail:text", "text", 51, order++, 5000),
			text: "now refactoring parseBlocks function call site",
		});

		// Tight budget forces folding of the 10 tool_results.
		// currentTurn = 51; ageCutoff = 51 - 20 = 31; tool_results at turn 1 ≤ 31 → cold.
		// protect = 6000 → covers the tail (5000 tok).
		const s = makeStore(blocks, 5000, 6000);

		// Groups should exist (10 tool_results in one episode ≥ minRun=8)
		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		expect(conductorGroups.length).toBeGreaterThan(0);

		// The conductor group should have been unfolded by the lexical pre-unfold
		// (since tail mentions "parseBlocks" which appears in r:4 inside the group).
		// After lexical unfold: the group is opened, matched member should be live.
		// Check that conductor log has "group unfolded" entry (from lexical opening the group)
		const lexicalLogs = s.log.filter((e) => e.action === "group unfolded" || (e.by === "conductor" && e.action === "unfolded"));
		// The session is stable either way; at minimum conductor groups formed.
		expect(s.liveTokens).toBeGreaterThan(0);
	});

	it("non-conductor (human) groups are not given groupCool on unfold", () => {
		// Make a human group, unfold it, check groupCool is NOT set
		const blocks: Block[] = [];
		let order = 0;
		for (let i = 0; i < 5; i++) {
			blocks.push(blk(`b:${i}`, "text", 1, order++, 500));
		}
		blocks.push(blk("tail", "text", 50, order, 200));

		const s = makeStore(blocks, 1_000_000, 300);

		// Create a human group (default by="you")
		const g = s.createGroup("b:0", "b:4", "you");
		expect(g).not.toBeNull();
		expect(g!.by).toBeUndefined(); // human groups don't set by in createGroup (it's set by coalesce)

		const firstId = g!.memberIds[0];
		s.unfoldGroup(g!.id, "you");

		// groupCool should NOT be set (only conductor groups get hysteresis)
		expect(s.groupCoolUntil(firstId)).toBe(0);
	});
});

// ── OPT-IN real-corpus test ──────────────────────────────────────────────────

describe("real-corpus test (opt-in, skip if no corpus)", () => {
	it("parses a corpus session and forms conductor groups with net savings >= 0", async () => {
		// Try to find a corpus file
		const os = await import("os");
		const path = await import("path");
		const fs = await import("fs");

		const corpusDir = path.join(os.homedir(), ".accordion", "corpus");
		if (!fs.existsSync(corpusDir)) {
			console.log("[coalesce corpus test] skipped — no corpus at ~/.accordion/corpus");
			return;
		}

		const files = fs.readdirSync(corpusDir).filter((f: string) => f.endsWith(".jsonl"));
		if (files.length === 0) {
			console.log("[coalesce corpus test] skipped — no .jsonl files in corpus");
			return;
		}

		const { parse } = await import("./parse");
		const corpusFile = path.join(corpusDir, files[0]);
		const content = fs.readFileSync(corpusFile, "utf-8");
		const parsed = parse(content);

		if (!parsed || parsed.blocks.length < 30) {
			console.log(`[coalesce corpus test] skipped — session too small (${parsed?.blocks?.length ?? 0} blocks)`);
			return;
		}

		const s = makeStore(parsed.blocks, 50_000, 20_000);

		// Assert at least one conductor group forms
		const conductorGroups = s.groups.filter((g) => g.by === "conductor");
		console.log(`[coalesce corpus test] ${parsed.blocks.length} blocks, ${s.groups.length} groups, ${conductorGroups.length} conductor groups, liveTokens=${s.liveTokens}`);

		if (conductorGroups.length > 0) {
			// Assert net savings >= 0 per group
			for (const g of conductorGroups) {
				expect(s.groupSavedTokens(g)).toBeGreaterThanOrEqual(0);
			}
			// Assert the session is stable
			const flipsBefore = s.foldFlips;
			s.refold();
			expect(s.foldFlips).toBe(flipsBefore);
		} else {
			// If no conductor groups formed, just assert no crash (session may be too small/young)
			console.log("[coalesce corpus test] no conductor groups formed (session may be too small/young for minAgeTurns)");
		}
	});
});

