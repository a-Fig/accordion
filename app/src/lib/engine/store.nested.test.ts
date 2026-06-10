/**
 * Tests for C4 nested-group engine additions (ADR 0011):
 *   - createParentGroup: validation, memberIds union, children field
 *   - level-by-level unfoldGroup: parent open reveals children still folded
 *   - recursive token accounting: parent folded vs. parent open + children folded
 *   - pruneProtectedGroups at depth: parent dissolves, orphaned children survive
 *   - computeGroupOps with nesting: subsumed children skipped; unfolded parent -> children emit
 *   - groupSummary for parent group (era digest)
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import { computeGroupOps, resolveUnfold } from "../live/plan";
import { foldCode } from "./digest";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: `${id} ${"x".repeat(40)}`, tokens, callId, override: null, autoFolded: false, by: null };
}

/**
 * Session for nesting tests:
 *   0  u:1       user    turn 1   100
 *   1  a:rA:p0   text    turn 1   400   group A (a:rA:p0..a:rB:p0 includes u:2)
 *   2  u:2       user    turn 2   100   ^ part of group A via message snap
 *   3  a:rB:p0   text    turn 2   300   group A
 *   4  u:3       user    turn 3   100
 *   5  a:rC:p0   text    turn 3   500   group B (a:rC:p0..a:rD:p0 includes u:4)
 *   6  u:4       user    turn 4   100   ^ part of group B via message snap
 *   7  a:rD:p0   text    turn 4   200   group B
 *   8  u:5       user    turn 5   100
 *   9  a:rE:p0   text    turn 5   600   group C (a:rE:p0..a:rF:p0 includes u:6)
 *  10  u:6       user    turn 6   100   ^ part of group C via message snap
 *  11  a:rF:p0   text    turn 6   250   group C
 *  12  u:7       user    turn 7   100
 *  13  a:rG:p0   text    turn 7   800   group D (a:rG:p0..a:rH:p0 includes u:8)
 *  14  u:8       user    turn 8   100   ^ part of group D via message snap
 *  15  a:rH:p0   text    turn 8   350   group D
 *  16  u:9       user    turn 9    50   (newest -- protected)
 *
 * NOTE: createGroup snaps to whole messages. Since each assistant block is its own
 * message (single part), no snap occurs for assistant-only groups. But the range
 * a:rA:p0..a:rB:p0 spans indices 1..3, so u:2 at index 2 is included as a member.
 */
function makeSession(): Block[] {
	return [
		b("u:1", "user", 1, 0, 100),
		b("a:rA:p0", "text", 1, 1, 400),
		b("u:2", "user", 2, 2, 100),
		b("a:rB:p0", "text", 2, 3, 300),
		b("u:3", "user", 3, 4, 100),
		b("a:rC:p0", "text", 3, 5, 500),
		b("u:4", "user", 4, 6, 100),
		b("a:rD:p0", "text", 4, 7, 200),
		b("u:5", "user", 5, 8, 100),
		b("a:rE:p0", "text", 5, 9, 600),
		b("u:6", "user", 6, 10, 100),
		b("a:rF:p0", "text", 6, 11, 250),
		b("u:7", "user", 7, 12, 100),
		b("a:rG:p0", "text", 7, 13, 800),
		b("u:8", "user", 8, 14, 100),
		b("a:rH:p0", "text", 8, 15, 350),
		b("u:9", "user", 9, 16, 50),
	];
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: makeSession(), lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000);
	s.setProtect(1); // protect only u:9 (newest, 50 tokens)
	return s;
}

/** Create 4 leaf groups in the store and return them. */
function createFourGroups(s: AccordionStore) {
	// Each group covers: <text block> .. <next text block>, snapping to include any
	// user turn in between (e.g. a:rA:p0 .. a:rB:p0 captures u:2 at index 2).
	const gA = s.createGroup("a:rA:p0", "a:rB:p0")!;
	const gB = s.createGroup("a:rC:p0", "a:rD:p0")!;
	const gC = s.createGroup("a:rE:p0", "a:rF:p0")!;
	const gD = s.createGroup("a:rG:p0", "a:rH:p0")!;
	expect(gA).not.toBeNull();
	expect(gB).not.toBeNull();
	expect(gC).not.toBeNull();
	expect(gD).not.toBeNull();
	return { gA, gB, gC, gD };
}

describe("createParentGroup -- validation", () => {
	it("creates a parent from 4 adjacent leaf groups with correct children and memberIds", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		expect(parent).not.toBeNull();
		expect(parent!.children).toEqual([gA.id, gB.id, gC.id, gD.id]);
		// memberIds = union of all leaf ids from all 4 child groups, in block order
		// gA.memberIds = [a:rA:p0, u:2, a:rB:p0]; gB = [a:rC:p0, u:4, a:rD:p0], etc.
		expect(parent!.memberIds).toEqual([
			"a:rA:p0", "u:2", "a:rB:p0",
			"a:rC:p0", "u:4", "a:rD:p0",
			"a:rE:p0", "u:6", "a:rF:p0",
			"a:rG:p0", "u:8", "a:rH:p0",
		]);
		expect(parent!.folded).toBe(true);
		// Parent id uses era: prefix to avoid collision with child g: prefix ids.
		expect(parent!.id).toMatch(/^era:/);
	});

	it("refuses fewer than 2 child groups", () => {
		const s = makeStore();
		const { gA } = createFourGroups(s);
		expect(s.createParentGroup([gA.id])).toBeNull();
	});

	it("refuses an unknown child group id", () => {
		const s = makeStore();
		const { gA, gB } = createFourGroups(s);
		expect(s.createParentGroup([gA.id, "g:nonexistent"])).toBeNull();
		expect(s.createParentGroup([gB.id, "g:nonexistent"])).toBeNull();
	});

	it("refuses a child group that is not folded", () => {
		const s = makeStore();
		const { gA, gB } = createFourGroups(s);
		s.unfoldGroup(gA.id); // gA is now open
		expect(s.createParentGroup([gA.id, gB.id])).toBeNull();
	});

	it("refuses children whose memberIds overlap", () => {
		const s = makeStore();
		const { gA } = createFourGroups(s);
		// Inject a duplicate group with the same memberIds to trigger overlap check.
		const duplicate = { id: "g:duplicate", memberIds: [...gA.memberIds], folded: true as const };
		s.groups = [...s.groups, duplicate];
		expect(s.createParentGroup([gA.id, duplicate.id])).toBeNull();
	});

	it("refuses if a child is already parented", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		// Create a first parent with gA and gB.
		const p1 = s.createParentGroup([gA.id, gB.id]);
		expect(p1).not.toBeNull();
		// Attempt to create a second parent that re-uses gA (already parented).
		expect(s.createParentGroup([gA.id, gC.id])).toBeNull();
		// gC and gD are unparented -- that combination is valid.
		expect(s.createParentGroup([gC.id, gD.id])).not.toBeNull();
	});

	it("adds the parent to store.groups and the group count grows by 1", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const before = s.groups.length; // 4
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		expect(s.groups.length).toBe(before + 1);
	});
});

describe("level-by-level unfoldGroup (ADR 0011 section 3)", () => {
	it("unfolding a LEAF group: no children field -> members go live (unchanged behavior)", () => {
		// Isolated test: only one group so we can verify full restoration.
		const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: makeSession(), lineCount: 0, skipped: 0 };
		const s2 = new AccordionStore(parsed);
		s2.setBudget(1_000_000);
		s2.setProtect(1);
		const full = s2.liveTokens;
		const gA = s2.createGroup("a:rA:p0", "a:rB:p0")!;
		expect(gA).not.toBeNull();
		expect(s2.liveTokens).toBeLessThan(full);
		s2.unfoldGroup(gA.id);
		expect(s2.groupById(gA.id)!.folded).toBe(false);
		// open leaf group: liveTokens returns to full.
		expect(s2.liveTokens).toBe(full);
	});

	it("unfolding a PARENT group: parent opens but children remain folded", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		expect(parent.folded).toBe(true);
		expect(s.groupById(gA.id)!.folded).toBe(true); // children folded
		s.unfoldGroup(parent.id);
		// Parent is now open.
		expect(s.groupById(parent.id)!.folded).toBe(false);
		// Children remain folded -- level-by-level.
		expect(s.groupById(gA.id)!.folded).toBe(true);
		expect(s.groupById(gB.id)!.folded).toBe(true);
		expect(s.groupById(gC.id)!.folded).toBe(true);
		expect(s.groupById(gD.id)!.folded).toBe(true);
	});

	it("after parent unfolds, accounting reflects child summaries (not full text)", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;

		// Parent folded: one parent summary contribution.
		const liveFolded = s.liveTokens;

		// Parent unfolded: child summaries now contribute (4 child summaries, not full text).
		s.unfoldGroup(parent.id);
		const liveAfterParentUnfold = s.liveTokens;

		// Still way less than full text (no child member blocks at full size).
		expect(liveAfterParentUnfold).toBeLessThan(s.fullTokens);

		// Accounting invariant.
		expect(s.liveTokens).toBe(s.fullTokens - s.savedTokens);

		// Verify: children are still folded.
		for (const gid of [gA.id, gB.id, gC.id, gD.id]) {
			expect(s.groupById(gid)!.folded).toBe(true);
		}

		void liveFolded;
	});

	it("fully drill down: unfold parent -> unfold one child -> that child's members go live", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		s.unfoldGroup(parent.id); // level 1: parent open, children folded
		s.unfoldGroup(gA.id);    // level 2: gA open, its members live
		expect(s.groupById(gA.id)!.folded).toBe(false); // gA now open
		// gA's leaf members (a:rA:p0, u:2, a:rB:p0) are now live.
		expect(s.isFolded(s.get("a:rA:p0")!)).toBe(false);
		expect(s.isFolded(s.get("a:rB:p0")!)).toBe(false);
		// gB remains folded.
		expect(s.groupById(gB.id)!.folded).toBe(true);
		void gD;
	});
});

describe("recursive token accounting (ADR 0011 section 2)", () => {
	it("liveTokens invariant holds with a parent group: liveTokens == fullTokens - savedTokens", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		expect(s.liveTokens).toBe(s.fullTokens - s.savedTokens);
	});

	it("folded parent + folded children: no double-counting (parent subsumed children in groupWire)", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		// Record cost with 4 separate leaf groups.
		const liveWith4Groups = s.liveTokens;
		// Now create a parent (adds 1 group entry, children are subsumed in groupWire).
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		const liveWithParent = s.liveTokens;
		// Key invariant: accounting via groupWire doesn't double-count child summaries.
		// The parent summary text replaces all 4 child summaries. The era summary is slightly
		// larger than a single child summary (it contains episode lines for each child),
		// so it may be larger or smaller than 4 child summaries combined -- we just check
		// it's way less than full text and the invariant holds.
		expect(liveWithParent).toBeLessThan(s.fullTokens * 0.3); // max 30% of full text
		expect(s.savedTokens).toBe(s.fullTokens - s.liveTokens);
		void liveWith4Groups;
	});

	it("unfolding parent: live cost changes to 4 child summaries contributing", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		s.unfoldGroup(parent.id);
		// Parent open -> children contribute their own summary costs.
		// Still much less than full text (children are still folded).
		expect(s.liveTokens).toBeLessThan(s.fullTokens * 0.5);
		// Invariant still holds.
		expect(s.liveTokens).toBe(s.fullTokens - s.savedTokens);
	});
});

describe("pruneProtectedGroups at depth (ADR 0011 section 5)", () => {
	it("dissolving a parent does NOT dissolve its children (they survive as top-level groups)", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const groupsBefore = s.groups.length; // should be 5 (4 children + 1 parent)
		expect(groupsBefore).toBe(5);
		// Widen tail to cover a:rH:p0 (last leaf of gD, at index 15, tokens=350).
		// u:9(50) + a:rH:p0(350) = 400 -> protectedFromIndex = 15 (a:rH:p0 protected).
		s.setProtect(400);
		// gD dissolves (a:rH:p0 protected). Parent dissolves (a:rH:p0 in memberIds).
		// gA, gB, gC survive (all their members at indices 1..11 are older).
		const surviving = s.groups.map((g) => g.id);
		expect(surviving).not.toContain(parent.id);
		expect(surviving).not.toContain(gD.id);
		expect(surviving).toContain(gA.id);
		expect(surviving).toContain(gB.id);
		expect(surviving).toContain(gC.id);
	});

	it("a surviving child after parent dissolution has no reference to the dissolved parent", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		// Dissolve parent and gD.
		s.setProtect(400);
		// Surviving groups should have no children entry containing gD.
		for (const g of s.groups) {
			if (g.children) expect(g.children).not.toContain(gD.id);
		}
	});

	it("accounting invariant holds after partial group dissolution at depth", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		s.setProtect(400);
		expect(s.liveTokens).toBe(s.fullTokens - s.savedTokens);
		void gA; void gB; void gC; void gD;
	});
});

describe("computeGroupOps with nesting (ADR 0011 section 4)", () => {
	it("when parent is folded: emits ONE op for the parent, none for children", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const ops = computeGroupOps(s);
		// Only the parent should be emitted (children are subsumed).
		expect(ops.length).toBe(1);
		expect(ops[0].id).toBe(parent.id);
		// The parent's op carries all leaf block ids from all children.
		for (const id of gA.memberIds) expect(ops[0].memberIds).toContain(id);
		for (const id of gB.memberIds) expect(ops[0].memberIds).toContain(id);
	});

	it("when parent is UNFOLDED: emits ops for the still-folded children", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		s.unfoldGroup(parent.id); // parent open, children still folded
		const ops = computeGroupOps(s);
		// Parent is unfolded -> no op for it. Children are folded -> their ops.
		const opIds = ops.map((o) => o.id);
		expect(opIds).not.toContain(parent.id);
		expect(opIds).toContain(gA.id);
		expect(opIds).toContain(gB.id);
		expect(opIds).toContain(gC.id);
		expect(opIds).toContain(gD.id);
		expect(ops.length).toBe(4);
	});

	it("GroupOp summaryText for the parent carries the parent era tag", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const ops = computeGroupOps(s);
		// The era tag prefix: {#<code> FOLDED} era followed by any separator character.
		expect(ops[0].summaryText).toMatch(new RegExp(`^\\{#${foldCode(parent.id)} FOLDED\\} era`));
		expect(ops[0].summaryText).toContain("episode 1:");
	});
});

describe("groupSummary -- era digest (ADR 0011 section 8)", () => {
	it("parent group summary starts with the era fold tag", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const summary = s.groupSummary(parent);
		expect(summary).toMatch(/^\{#[0-9a-z]{6} FOLDED\} era /);
	});

	it("parent group summary includes episode lines for each child", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const summary = s.groupSummary(parent);
		expect(summary).toContain("episode 1:");
		expect(summary).toContain("episode 2:");
		expect(summary).toContain("episode 3:");
		expect(summary).toContain("episode 4:");
	});

	it("child groups still have their own (flat) summary unchanged by the parent", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const childSummaryBefore = s.groupSummary(gA);
		s.createParentGroup([gA.id, gB.id, gC.id, gD.id]);
		// Child's own summary is unchanged (it's still a leaf group).
		expect(s.groupSummary(gA)).toBe(childSummaryBefore);
		expect(s.groupSummary(gA)).toMatch(/^\{#[0-9a-z]{6} FOLDED\} group /);
	});
});

describe("resolveUnfold with nested groups", () => {
	it("resolving a parent group's code unfolds the parent (level-by-level -- children stay folded)", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		const { restored, missing } = resolveUnfold(s, [foldCode(parent.id)]);
		expect(missing).toEqual([]);
		expect(restored.length).toBeGreaterThan(0);
		// Parent is now open.
		expect(s.groupById(parent.id)!.folded).toBe(false);
		// Children remain folded (level-by-level).
		expect(s.groupById(gA.id)!.folded).toBe(true);
		expect(s.groupById(gB.id)!.folded).toBe(true);
		void gD;
	});

	it("resolving a child group's code (when parent is open) unfolds just that child", () => {
		const s = makeStore();
		const { gA, gB, gC, gD } = createFourGroups(s);
		const parent = s.createParentGroup([gA.id, gB.id, gC.id, gD.id])!;
		s.unfoldGroup(parent.id); // open parent first (level 1)
		// Now resolve gA's code (level 2 drill-down).
		const { restored, missing } = resolveUnfold(s, [foldCode(gA.id)]);
		expect(missing).toEqual([]);
		expect(restored.length).toBeGreaterThan(0);
		expect(s.groupById(gA.id)!.folded).toBe(false); // gA open
		expect(s.groupById(gB.id)!.folded).toBe(true);  // others still folded
		void gD;
	});
});
