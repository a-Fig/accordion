import { describe, it, expect } from "vitest";
import { AccordionStore } from "../engine/store.svelte";
import type { Block, BlockKind, ParsedSession } from "../engine/types";
import { computeFoldOps, resolveUnfold } from "./plan";
import { isDurableId } from "./mapping";

// computeFoldOps mirrors the engine's LOCAL fold decisions into provider-safe wire
// ops. These tests lock the kind filter, the durable-id guard, and the empty-digest
// skip — the defense-in-depth that keeps a fold from orphaning a tool_call, folding
// user intent, or instructing a fold against an id we can't durably re-identify.

interface BlkOpts {
	id: string;
	kind?: BlockKind;
	tokens?: number;
	text?: string;
	toolName?: string;
	callId?: string;
}

let order = 0;
function blk(o: BlkOpts): Block {
	const i = order++;
	return {
		id: o.id,
		kind: o.kind ?? "text",
		turn: i + 1,
		order: i,
		text: o.text ?? `block ${i} ` + "lorem ipsum dolor sit amet ".repeat(8),
		tokens: o.tokens ?? 8000,
		toolName: o.toolName,
		callId: o.callId,
		override: null,
		autoFolded: false,
		by: null,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	order = 0;
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

describe("computeFoldOps", () => {
	it("emits ops for folded text/thinking/tool_result blocks with durable ids", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "a:resp1:p1", kind: "thinking", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			// small recent tail (protected)
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
			blk({ id: "a:resp2:p0", kind: "text", tokens: 50, text: "ok" }),
		];
		const s = makeStore(blocks);
		s.setProtect(80); // protect only the tiny recent tail
		s.setBudget(1000); // force auto-folds on the old large blocks

		// sanity: fixtures actually fold something
		expect(s.foldedCount).toBeGreaterThan(0);

		const ops = computeFoldOps(s);
		// the three foldable old blocks should appear, in block order
		expect(ops.map((o) => o.id)).toEqual(["a:resp1:p0", "a:resp1:p1", "r:call1"]);
		for (const op of ops) {
			const b = s.get(op.id)!;
			expect(s.isFolded(b)).toBe(true);
			expect(op.digestText).toBe(s.digestOf(b));
			expect(op.digestText.length).toBeGreaterThan(0);
		}
	});

	it("excludes a folded tool_call (folding it would orphan its result)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "tool_call", tokens: 8000, toolName: "read", callId: "c1" }),
			blk({ id: "a:resp1:p1", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		// force-fold the non-protected tool_call by hand
		s.fold("a:resp1:p0");
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(true);

		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("a:resp1:p0");
	});

	it("excludes a folded user block (intent is never folded)", () => {
		order = 0;
		const blocks = [
			blk({ id: "u:500", kind: "user", tokens: 8000 }),
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.fold("u:500"); // force-fold the old user block
		expect(s.isFolded(s.get("u:500")!)).toBe(true);

		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("u:500");
	});

	it("excludes a folded block with a positional/fallback id (durable-id guard)", () => {
		order = 0;
		const blocks = [
			blk({ id: "m9:p0", kind: "text", tokens: 8000 }), // positional fallback id
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // auto-fold the old blocks

		expect(s.isFolded(s.get("m9:p0")!)).toBe(true); // it IS folded by the engine
		const ops = computeFoldOps(s);
		expect(ops.map((o) => o.id)).not.toContain("m9:p0"); // but never emitted
		expect(ops.map((o) => o.id)).toContain("a:resp1:p0"); // the durable one is
	});

	it("returns [] when nothing is folded", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 50, text: "a" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(0);
		s.setBudget(1_000_000); // far above live size → nothing folds
		expect(s.foldedCount).toBe(0);
		expect(computeFoldOps(s)).toEqual([]);
	});

	it("tags each op's digestText with the block's own id so the agent can unfold it", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);

		const ops = computeFoldOps(s);
		expect(ops.length).toBeGreaterThan(0);
		for (const op of ops) {
			// the agent reads `{#<id> FOLDED}` and passes <id> back — so the op MUST carry
			// its own id in its tag, not some other block's.
			expect(op.digestText.startsWith(`{#${op.id} FOLDED} `)).toBe(true);
		}
	});
});

describe("resolveUnfold", () => {
	it("restores known ids (sticky, provenance agent) and reports unknown ids as missing", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000); // fold the old blocks
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(true);

		const { restored, missing } = resolveUnfold(s, ["a:resp1:p0", "nope:404"]);

		// the known block is now held open, with agent provenance
		const b = s.get("a:resp1:p0")!;
		expect(s.isFolded(b)).toBe(false);
		expect(b.override).toBe("unfolded");
		expect(b.by).toBe("agent");
		// returned record carries id + kind + a label, NO content (state-change-only)
		expect(restored.map((r) => r.id)).toEqual(["a:resp1:p0"]);
		expect(restored[0].kind).toBe("text");
		expect(restored[0].label).toContain("text");
		expect("text" in restored[0]).toBe(false);
		// the unknown id is reported, not silently dropped
		expect(missing).toEqual(["nope:404"]);
	});

	it("refuses to touch a human-pinned block — reports it missing, pin survives", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		s.pin("a:resp1:p0"); // human pins it open
		expect(s.get("a:resp1:p0")!.override).toBe("pinned");

		// the agent must NOT be able to convert a pin into an agent-unfold (it can request,
		// never force). The pinned id is reported as nothing-to-restore.
		const { restored, missing } = resolveUnfold(s, ["a:resp1:p0"]);
		expect(restored).toEqual([]);
		expect(missing).toEqual(["a:resp1:p0"]);
		expect(s.get("a:resp1:p0")!.override).toBe("pinned"); // pin intact
		expect(s.get("a:resp1:p0")!.by).toBe("you");
	});

	it("refuses an already-full (never-folded) block — reports missing, leaves it auto", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 50, text: "small" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setBudget(1_000_000); // nothing folds
		expect(s.isFolded(s.get("a:resp1:p0")!)).toBe(false);

		const { restored, missing } = resolveUnfold(s, ["a:resp1:p0"]);
		expect(restored).toEqual([]);
		expect(missing).toEqual(["a:resp1:p0"]);
		// it must NOT have been flipped to a sticky agent-unfold override
		expect(s.get("a:resp1:p0")!.override).toBe(null);
	});

	it("an unfolded block no longer appears in the fold plan (restores at next context)", () => {
		order = 0;
		const blocks = [
			blk({ id: "a:resp1:p0", kind: "text", tokens: 8000 }),
			blk({ id: "r:call1", kind: "tool_result", tokens: 8000, toolName: "grep", callId: "call1" }),
			blk({ id: "u:1000", kind: "user", tokens: 50, text: "hi" }),
		];
		const s = makeStore(blocks);
		s.setProtect(40);
		s.setBudget(1000);
		expect(computeFoldOps(s).map((o) => o.id)).toContain("a:resp1:p0");

		resolveUnfold(s, ["a:resp1:p0"]);
		// next plan omits it → the extension sends it full → agent's past context changes
		expect(computeFoldOps(s).map((o) => o.id)).not.toContain("a:resp1:p0");
	});
});

describe("isDurableId", () => {
	it("is true for durable, content-anchored ids", () => {
		expect(isDurableId("u:1")).toBe(true);
		expect(isDurableId("a:resp:p0")).toBe(true);
		expect(isDurableId("r:abc")).toBe(true);
		expect(isDurableId("s:9")).toBe(true);
	});
	it("is false for positional fallback ids", () => {
		expect(isDurableId("m0:u")).toBe(false);
		expect(isDurableId("m5:p0")).toBe(false);
		expect(isDurableId("m3:r")).toBe(false);
		expect(isDurableId("m2:s")).toBe(false);
	});
});
