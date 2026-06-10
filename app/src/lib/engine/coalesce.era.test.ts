/**
 * Tests for `findEraRuns` (engine/coalesce.ts) — the C4 upward-coalescing schedule
 * that identifies runs of adjacent folded groups eligible to form era parent groups
 * (ADR 0011 §7).
 */
import { describe, it, expect } from "vitest";
import { findEraRuns, MIN_ERA_GROUPS, ERA_AGE_TURNS, MAX_ERA_GROUPS } from "./coalesce";
import type { Block, Group } from "./types";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number = 200): Block {
	return { id, kind, turn, order, text: `${id} x`, tokens, override: null, autoFolded: false, by: null };
}

function leafGroup(id: string, memberIds: string[]): Group {
	return { id, memberIds, folded: true };
}

function parentGroup(id: string, memberIds: string[], children: string[]): Group {
	return { id, memberIds, folded: true, children };
}

describe("findEraRuns — basic eligibility", () => {
	it("returns [] when fewer than MIN_ERA_GROUPS eligible groups exist", () => {
		// 3 groups — below the threshold of 4.
		const blocks: Block[] = [
			b("u:1", "user", 1, 0),
			b("a:1", "text", 1, 1),
			b("u:2", "user", 2, 2),
			b("a:2", "text", 2, 3),
			b("u:3", "user", 3, 4),
			b("a:3", "text", 3, 5),
			b("u:4", "user", 400, 6), // current turn is 400
		];
		const groups: Group[] = [leafGroup("g:a:1", ["a:1"]), leafGroup("g:a:2", ["a:2"]), leafGroup("g:a:3", ["a:3"])];
		const result = findEraRuns(groups, blocks, 400);
		expect(result).toEqual([]);
	});

	it("finds one era run when exactly MIN_ERA_GROUPS adjacent eligible groups exist", () => {
		// 4 groups, all turns 1–4, current turn 305 (all > ERA_AGE_TURNS old).
		const blocks: Block[] = [
			b("u:1", "user", 1, 0),
			b("a:1", "text", 1, 1),
			b("u:2", "user", 2, 2),
			b("a:2", "text", 2, 3),
			b("u:3", "user", 3, 4),
			b("a:3", "text", 3, 5),
			b("u:4", "user", 4, 6),
			b("a:4", "text", 4, 7),
			b("u:305", "user", 305, 8), // current turn (newest block)
		];
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]),
			leafGroup("g:a:2", ["a:2"]),
			leafGroup("g:a:3", ["a:3"]),
			leafGroup("g:a:4", ["a:4"]),
		];
		const result = findEraRuns(groups, blocks, 305);
		expect(result.length).toBe(1);
		expect(result[0]).toEqual(["g:a:1", "g:a:2", "g:a:3", "g:a:4"]);
	});

	it("excludes groups with members younger than ERA_AGE_TURNS", () => {
		// 5 groups; the last one has a member at turn 200 (current 305 → 305-200=105 < 300).
		const blocks: Block[] = [
			b("u:1", "user", 1, 0),
			b("a:1", "text", 1, 1),
			b("u:2", "user", 2, 2),
			b("a:2", "text", 2, 3),
			b("u:3", "user", 3, 4),
			b("a:3", "text", 3, 5),
			b("u:4", "user", 4, 6),
			b("a:4", "text", 4, 7),
			b("u:200", "user", 200, 8), // group 5's member — 305-200=105 < ERA_AGE_TURNS
			b("a:5", "text", 200, 9),
			b("u:305", "user", 305, 10),
		];
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]),
			leafGroup("g:a:2", ["a:2"]),
			leafGroup("g:a:3", ["a:3"]),
			leafGroup("g:a:4", ["a:4"]),
			leafGroup("g:a:5", ["a:5"]), // too recent
		];
		const result = findEraRuns(groups, blocks, 305);
		// groups 1-4 are eligible and adjacent; group 5 is excluded.
		expect(result.length).toBe(1);
		expect(result[0]).toEqual(["g:a:1", "g:a:2", "g:a:3", "g:a:4"]);
	});

	it("excludes unfolded groups", () => {
		const blocks: Block[] = [
			b("u:1", "user", 1, 0),
			b("a:1", "text", 1, 1),
			b("u:2", "user", 2, 2),
			b("a:2", "text", 2, 3),
			b("u:3", "user", 3, 4),
			b("a:3", "text", 3, 5),
			b("u:4", "user", 4, 6),
			b("a:4", "text", 4, 7),
			b("u:305", "user", 305, 8),
		];
		// Group 2 is unfolded.
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]),
			{ id: "g:a:2", memberIds: ["a:2"], folded: false }, // unfolded
			leafGroup("g:a:3", ["a:3"]),
			leafGroup("g:a:4", ["a:4"]),
		];
		const result = findEraRuns(groups, blocks, 305);
		// 3 remaining eligible but split by the unfolded group → two runs of 1, 2.
		// Neither run reaches MIN_ERA_GROUPS=4.
		expect(result).toEqual([]);
	});

	it("excludes groups already parented", () => {
		const blocks: Block[] = [
			b("u:1", "user", 1, 0),
			b("a:1", "text", 1, 1),
			b("u:2", "user", 2, 2),
			b("a:2", "text", 2, 3),
			b("u:3", "user", 3, 4),
			b("a:3", "text", 3, 5),
			b("u:4", "user", 4, 6),
			b("a:4", "text", 4, 7),
			b("u:305", "user", 305, 8),
		];
		// g:a:1 and g:a:2 are already parented.
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]),
			leafGroup("g:a:2", ["a:2"]),
			leafGroup("g:a:3", ["a:3"]),
			leafGroup("g:a:4", ["a:4"]),
			parentGroup("g:parent", ["a:1", "a:2"], ["g:a:1", "g:a:2"]),
		];
		const result = findEraRuns(groups, blocks, 305);
		// g:a:1 and g:a:2 are already parented → excluded.
		// g:a:3 and g:a:4 remain: 2 eligible, below MIN_ERA_GROUPS=4.
		expect(result).toEqual([]);
	});
});

describe("findEraRuns — adjacency", () => {
	it("user-turn gaps between groups are allowed (they are natural episode separators)", () => {
		// Groups with user turns between them — this is the typical case after conductor coalescing.
		const blocks: Block[] = [
			b("a:1", "text", 1, 0),
			b("u:sep1", "user", 2, 1), // user separator
			b("a:2", "text", 2, 2),
			b("u:sep2", "user", 3, 3),
			b("a:3", "text", 3, 4),
			b("u:sep3", "user", 4, 5),
			b("a:4", "text", 4, 6),
			b("u:305", "user", 305, 7),
		];
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]), // last member at idx 0
			leafGroup("g:a:2", ["a:2"]), // first member at idx 2 (gap = idx 1 = user turn)
			leafGroup("g:a:3", ["a:3"]), // first member at idx 4 (gap = idx 3 = user turn)
			leafGroup("g:a:4", ["a:4"]), // first member at idx 6 (gap = idx 5 = user turn)
		];
		const result = findEraRuns(groups, blocks, 305);
		expect(result.length).toBe(1);
		expect(result[0]).toEqual(["g:a:1", "g:a:2", "g:a:3", "g:a:4"]);
	});

	it("an unfolded foldable block between groups breaks adjacency", () => {
		// A non-user, non-folded block between groups breaks the adjacency.
		const blocks: Block[] = [
			b("a:1", "text", 1, 0),
			b("a:gap", "text", 1, 1), // foldable, NOT in any group → breaks adjacency
			b("a:2", "text", 2, 2),
			b("a:3", "text", 3, 3),
			b("a:4", "text", 4, 4),
			b("a:5", "text", 5, 5),
			b("u:305", "user", 305, 6),
		];
		const groups: Group[] = [
			leafGroup("g:a:1", ["a:1"]),
			leafGroup("g:a:2", ["a:2"]), // gap block between g:a:1 and g:a:2
			leafGroup("g:a:3", ["a:3"]),
			leafGroup("g:a:4", ["a:4"]),
			leafGroup("g:a:5", ["a:5"]),
		];
		const result = findEraRuns(groups, blocks, 305);
		// g:a:1 is separated from the rest by a:gap → only g:a:2..g:a:5 form a run (4 groups).
		expect(result.length).toBe(1);
		expect(result[0]).toEqual(["g:a:2", "g:a:3", "g:a:4", "g:a:5"]);
	});
});

describe("findEraRuns — MAX_ERA_GROUPS cap", () => {
	it("a very long run is split at MAX_ERA_GROUPS boundaries", () => {
		// Build MAX_ERA_GROUPS + 2 groups to test the cap.
		const count = MAX_ERA_GROUPS + 2;
		const blocks: Block[] = [];
		const groups: Group[] = [];
		for (let i = 1; i <= count; i++) {
			blocks.push(b(`a:${i}`, "text", i, i - 1));
			groups.push(leafGroup(`g:a:${i}`, [`a:${i}`]));
		}
		// Add a sentinel "current" block so we have a turn reference.
		blocks.push(b("u:last", "user", count + ERA_AGE_TURNS, count));
		const result = findEraRuns(groups, blocks, count + ERA_AGE_TURNS);
		// Should produce at least one run of MAX_ERA_GROUPS and one remainder.
		expect(result.length).toBeGreaterThanOrEqual(1);
		for (const run of result) {
			expect(run.length).toBeLessThanOrEqual(MAX_ERA_GROUPS);
		}
		// The first run should be exactly MAX_ERA_GROUPS.
		expect(result[0].length).toBe(MAX_ERA_GROUPS);
	});
});

describe("findEraRuns — multiple separate runs", () => {
	it("two separate groups of >= MIN_ERA_GROUPS each produce two runs", () => {
		// 8 groups in two separated clusters of 4, separated by an unfolded block.
		const blocks: Block[] = [];
		const groups: Group[] = [];
		// Cluster 1: turns 1-4 at indices 0-3.
		for (let i = 1; i <= 4; i++) {
			blocks.push(b(`a:${i}`, "text", i, i - 1));
			groups.push(leafGroup(`g:a:${i}`, [`a:${i}`]));
		}
		// Gap: an unfolded text block at index 4.
		blocks.push(b("a:gap", "text", 5, 4));
		// Cluster 2: turns 6-9 at indices 5-8.
		for (let i = 6; i <= 9; i++) {
			blocks.push(b(`a:${i}`, "text", i, i));
			groups.push(leafGroup(`g:a:${i}`, [`a:${i}`]));
		}
		blocks.push(b("u:last", "user", 500, 9));
		const result = findEraRuns(groups, blocks, 500);
		expect(result.length).toBe(2);
		expect(result[0]).toEqual(["g:a:1", "g:a:2", "g:a:3", "g:a:4"]);
		expect(result[1]).toEqual(["g:a:6", "g:a:7", "g:a:8", "g:a:9"]);
	});
});
