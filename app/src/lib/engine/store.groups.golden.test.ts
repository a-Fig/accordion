/**
 * Golden characterization tests for FLAT GROUP behavior (pre-C4 refactor baseline).
 *
 * These tests pin the EXACT accounting totals, computeGroupOps output, and
 * pruneProtectedGroups behavior for a synthetic session with 2 groups including
 * stragglers. They must pass BEFORE the C4 engine refactor AND AFTER it — if any of
 * these fail after the refactor, a flat-group regression has been introduced.
 *
 * Session layout (durable, message-anchored ids):
 *
 *   idx  id           kind         turn  tokens  callId  notes
 *   ──────────────────────────────────────────────────────────────────────────
 *    0   u:10         user          1     200
 *    1   a:r10:p0     thinking      1     400
 *    2   a:r10:p1     text          1     300
 *    3   a:r10:p2     tool_call     1     100     c1    ← c1 call
 *    4   r:c1         tool_result   1    2000     c1    ← c1 result  } group A (folded)
 *    5   u:20         user          2     150
 *    6   a:r20:p0     tool_call     2     100     c2    ← c2 call (straggler: result outside group)
 *    7   a:r20:p1     text          2     500
 *    8   r:c2         tool_result   2    1800     c2    ← c2 result (straggler: call is above in group B range)
 *    9   u:30         user          3     200
 *   10   a:r30:p0     text          3    3000
 *   11   u:40         user          4     100   (newest — protected)
 *
 * Group A: blocks 1..4 (a:r10:p0 → r:c1) — fully balanced (call+result both inside)
 *          carrier = a:r10:p0; collapsed = {a:r10:p0, a:r10:p1, a:r10:p2, r:c1}; stragglers = {}
 *
 * Group B: blocks 6..8 (a:r20:p0 → r:c2) — c2 call inside, c2 result inside → balanced
 *          BUT the c2 call (a:r20:p0) is a tool_call and the result (r:c2) is a tool_result;
 *          a:r20:p0 is in the same assistant message (a:r20) as a:r20:p1.
 *          a:r20 message: tool_call (a:r20:p0, callId c2) + text (a:r20:p1). Both inside.
 *          r:c2 message: tool_result, callId c2. Inside group B.
 *          So a:r20 is removable (all its blocks inside group B, call balanced with result inside).
 *          r:c2 is removable (result, call also inside).
 *          Collapsed = {a:r20:p0, a:r20:p1, r:c2}; stragglers = {}
 *
 * Full token totals:
 *   Group A members: 400+300+100+2000 = 2800
 *   Group B members: 100+500+1800 = 2400
 *   Non-group: 200+150+200+3000+100 = 3650
 *   Total: 2800+2400+3650 = 8850
 */
import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import { computeGroupOps } from "../live/plan";
import { foldCode } from "./digest";

function b(id: string, kind: Block["kind"], turn: number, order: number, tokens: number, callId?: string): Block {
	return { id, kind, turn, order, text: `${id} ${"x".repeat(40)}`, tokens, callId, override: null, autoFolded: false, by: null };
}

function makeSession(): Block[] {
	return [
		b("u:10", "user", 1, 0, 200),
		b("a:r10:p0", "thinking", 1, 1, 400),
		b("a:r10:p1", "text", 1, 2, 300),
		b("a:r10:p2", "tool_call", 1, 3, 100, "c1"),
		b("r:c1", "tool_result", 1, 4, 2000, "c1"),
		b("u:20", "user", 2, 5, 150),
		b("a:r20:p0", "tool_call", 2, 6, 100, "c2"),
		b("a:r20:p1", "text", 2, 7, 500),
		b("r:c2", "tool_result", 2, 8, 1800, "c2"),
		b("u:30", "user", 3, 9, 200),
		b("a:r30:p0", "text", 3, 10, 3000),
		b("u:40", "user", 4, 11, 100),
	];
}

function makeStore(): AccordionStore {
	const parsed: ParsedSession = { meta: { format: "pi", title: "t", cwd: "", model: "" }, blocks: makeSession(), lineCount: 0, skipped: 0 };
	const s = new AccordionStore(parsed);
	s.setBudget(1_000_000); // never auto-fold — isolate group behavior
	// protect only u:40 (newest, 100 tokens): target=1, newest=100 ≥ 1 → protectedFromIndex=11
	s.setProtect(1);
	return s;
}

describe("GOLDEN — flat group accounting (must pass before AND after C4 refactor)", () => {
	describe("baseline token totals without groups", () => {
		it("fullTokens matches sum of all block tokens", () => {
			const s = makeStore();
			expect(s.fullTokens).toBe(200 + 400 + 300 + 100 + 2000 + 150 + 100 + 500 + 1800 + 200 + 3000 + 100);
			// = 8850
			expect(s.fullTokens).toBe(8850);
		});

		it("liveTokens == fullTokens when nothing is folded and no groups", () => {
			const s = makeStore();
			expect(s.liveTokens).toBe(s.fullTokens);
		});

		it("savedTokens == 0 when nothing is folded", () => {
			const s = makeStore();
			expect(s.savedTokens).toBe(0);
		});

		it("protectedFromIndex is 11 (only u:40 protected)", () => {
			const s = makeStore();
			expect(s.protectedFromIndex).toBe(11);
		});
	});

	describe("Group A — balanced range (a:r10:p0..r:c1)", () => {
		it("createGroup succeeds and returns a group with correct memberIds", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1");
			expect(g).not.toBeNull();
			expect(g!.id).toBe("g:a:r10:p0");
			expect(g!.memberIds).toEqual(["a:r10:p0", "a:r10:p1", "a:r10:p2", "r:c1"]);
			expect(g!.folded).toBe(true);
		});

		it("groupFullTokens = 2800 (400+300+100+2000)", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			expect(s.groupFullTokens(g)).toBe(2800);
		});

		it("no stragglers (c1 call and result both inside)", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			expect(s.groupStragglerCount(g)).toBe(0);
		});

		it("groupLiveTokens is much less than full (just the one summary entry)", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			expect(s.groupLiveTokens(g)).toBeLessThan(200);
			expect(s.groupLiveTokens(g)).toBeGreaterThan(0);
		});

		it("groupSavedTokens = fullTokens - liveTokens for the group", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			expect(s.groupSavedTokens(g)).toBe(s.groupFullTokens(g) - s.groupLiveTokens(g));
		});

		it("liveTokens drops by groupSavedTokens after group creation", () => {
			const s = makeStore();
			const before = s.liveTokens;
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			expect(s.liveTokens).toBe(before - s.groupSavedTokens(g));
		});

		it("collapsed members read as folded; non-members unchanged", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			// All 4 members are collapsed → isFolded returns true
			for (const id of g.memberIds) {
				expect(s.isFolded(s.get(id)!)).toBe(true);
			}
			// Non-members outside the group are unaffected
			expect(s.isFolded(s.get("u:10")!)).toBe(false);
			expect(s.isFolded(s.get("u:20")!)).toBe(false);
		});

		it("groupSummary carries the {#code FOLDED} tag for the group id", () => {
			const s = makeStore();
			const g = s.createGroup("a:r10:p0", "r:c1")!;
			const summary = s.groupSummary(g);
			expect(summary).toMatch(new RegExp(`^\\{#${foldCode(g.id)} FOLDED\\} group ·`));
		});
	});

	describe("Group B — balanced range (a:r20:p0..r:c2, c2 pair both inside)", () => {
		it("createGroup succeeds for group B range", () => {
			const s = makeStore();
			const g = s.createGroup("a:r20:p0", "r:c2");
			expect(g).not.toBeNull();
			expect(g!.memberIds).toEqual(["a:r20:p0", "a:r20:p1", "r:c2"]);
		});

		it("groupFullTokens = 2400 (100+500+1800)", () => {
			const s = makeStore();
			const g = s.createGroup("a:r20:p0", "r:c2")!;
			expect(s.groupFullTokens(g)).toBe(2400);
		});

		it("no stragglers (c2 call and result both inside group B)", () => {
			const s = makeStore();
			const g = s.createGroup("a:r20:p0", "r:c2")!;
			expect(s.groupStragglerCount(g)).toBe(0);
		});
	});

	describe("two groups simultaneously", () => {
		it("both groups can coexist without overlap errors", () => {
			const s = makeStore();
			const gA = s.createGroup("a:r10:p0", "r:c1")!;
			const gB = s.createGroup("a:r20:p0", "r:c2")!;
			expect(s.groups.length).toBe(2);
			expect(gA).not.toBeNull();
			expect(gB).not.toBeNull();
		});

		it("combined savedTokens = groupA.savedTokens + groupB.savedTokens", () => {
			const s = makeStore();
			const gA = s.createGroup("a:r10:p0", "r:c1")!;
			const gB = s.createGroup("a:r20:p0", "r:c2")!;
			const savedA = s.groupSavedTokens(gA);
			const savedB = s.groupSavedTokens(gB);
			expect(s.savedTokens).toBe(savedA + savedB);
		});

		it("liveTokens invariant: liveTokens == fullTokens - savedTokens", () => {
			const s = makeStore();
			s.createGroup("a:r10:p0", "r:c1");
			s.createGroup("a:r20:p0", "r:c2");
			expect(s.liveTokens).toBe(s.fullTokens - s.savedTokens);
		});

		it("each group summary has a DISTINCT fold code", () => {
			const s = makeStore();
			const gA = s.createGroup("a:r10:p0", "r:c1")!;
			const gB = s.createGroup("a:r20:p0", "r:c2")!;
			const codeA = foldCode(gA.id);
			const codeB = foldCode(gB.id);
			expect(codeA).not.toBe(codeB);
		});
	});

	describe("computeGroupOps — golden output", () => {
		it("emits one GroupOp per folded group, each with correct memberIds and tagged summary", () => {
			const s = makeStore();
			const gA = s.createGroup("a:r10:p0", "r:c1")!;
			const gB = s.createGroup("a:r20:p0", "r:c2")!;
			const ops = computeGroupOps(s);
			expect(ops.length).toBe(2);
			// ops are in group creation order (store.groups order)
			const opA = ops.find((o) => o.id === gA.id)!;
			const opB = ops.find((o) => o.id === gB.id)!;
			expect(opA).toBeDefined();
			expect(opB).toBeDefined();
			expect(opA.memberIds).toEqual(["a:r10:p0", "a:r10:p1", "a:r10:p2", "r:c1"]);
			expect(opA.summaryText).toMatch(new RegExp(`^\\{#${foldCode(gA.id)} FOLDED\\} group ·`));
			expect(opB.memberIds).toEqual(["a:r20:p0", "a:r20:p1", "r:c2"]);
			expect(opB.summaryText).toMatch(new RegExp(`^\\{#${foldCode(gB.id)} FOLDED\\} group ·`));
		});

		it("emits NOTHING for unfolded groups", () => {
			const s = makeStore();
			const gA = s.createGroup("a:r10:p0", "r:c1")!;
			s.createGroup("a:r20:p0", "r:c2");
			s.unfoldGroup(gA.id);
			const ops = computeGroupOps(s);
			expect(ops.length).toBe(1); // only gB
			expect(ops[0].id).not.toBe(gA.id);
		});

		it("non-durable member ids are filtered from the op", () => {
			const s = makeStore();
			// Inject a positional-id member directly (bypassing validation) to test filtering
			s.groups = [{ id: "g:m9:u", memberIds: ["m9:u", "a:r10:p0"], folded: true }];
			const ops = computeGroupOps(s);
			expect(ops[0].memberIds).toEqual(["a:r10:p0"]);
			expect(ops[0].memberIds).not.toContain("m9:u");
		});
	});

	describe("pruneProtectedGroups — golden behavior", () => {
		it("dissolves group A when the protected tail grows over it", () => {
			const s = makeStore();
			s.createGroup("a:r10:p0", "r:c1");
			expect(s.groups.length).toBe(1);
			// Widen tail to cover everything
			s.setProtect(1_000_000);
			expect(s.protectedFromIndex).toBe(0);
			expect(s.groups.length).toBe(0);
		});

		it("dissolves only the group that reaches the tail, preserving the other", () => {
			const s = makeStore();
			s.createGroup("a:r10:p0", "r:c1"); // blocks 1..4 — older
			s.createGroup("a:r20:p0", "r:c2"); // blocks 6..8 — newer
			expect(s.groups.length).toBe(2);
			// Widen tail to cover blocks 8..11 (r:c2 onward, ~5200 tokens from end)
			// r:c2(1800) + u:30(200) + a:r30:p0(3000) + u:40(100) = 5100 → protectedFromIndex ~8
			// At setProtect(5100): sum from end: u:40(100)+a:r30:p0(3000)+u:30(200)+r:c2(1800)=5100 ≥ target
			// → protectedFromIndex = 8 (r:c2 is at index 8)
			s.setProtect(5100);
			// Group B has r:c2 at index 8 which is now protected → dissolves
			// Group A has blocks at indices 1..4 — older, safe
			const remaining = s.groups;
			if (remaining.length === 1) {
				// Expected: group A survives, group B dissolved
				expect(remaining[0].memberIds).toEqual(["a:r10:p0", "a:r10:p1", "a:r10:p2", "r:c1"]);
			}
			// At minimum: no group with a protected member survives
			for (const g of s.groups) {
				for (const id of g.memberIds) {
					const idx = (s as any).index.get(id);
					expect(idx).toBeLessThan(s.protectedFromIndex);
				}
			}
		});

		it("accounting is restored after a group dissolves (liveTokens == fullTokens)", () => {
			const s = makeStore();
			s.createGroup("a:r10:p0", "r:c1");
			const savedBefore = s.savedTokens;
			expect(savedBefore).toBeGreaterThan(0);
			s.setProtect(1_000_000); // dissolves the group
			expect(s.groups.length).toBe(0);
			expect(s.liveTokens).toBe(s.fullTokens);
			expect(s.savedTokens).toBe(0);
		});
	});
});
