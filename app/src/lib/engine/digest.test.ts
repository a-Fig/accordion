import { describe, it, expect } from "vitest";
import type { Block, BlockKind } from "./types";
import { digest, digestTokens, foldTag } from "./digest";
import { estTokens, BLOCK_OVERHEAD } from "./tokens";

// The folded digest carries a leading `{#<id> FOLDED}` tag. This is the engine's
// single source of truth: the same string is rendered in the GUI, sent on the wire,
// AND counted by digestTokens. These tests lock the tag's presence and shape, and
// that token accounting includes it (so the saved-tokens figure never lies).

function blk(o: Partial<Block> & { id: string; kind: BlockKind }): Block {
	return {
		id: o.id,
		kind: o.kind,
		turn: o.turn ?? 1,
		order: o.order ?? 0,
		text: o.text ?? "some content here that is long enough to summarize",
		tokens: o.tokens ?? 500,
		toolName: o.toolName,
		callId: o.callId,
		isError: o.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

describe("foldTag", () => {
	it("formats the marker as {#<id> FOLDED}", () => {
		expect(foldTag("a:resp-abc:p0")).toBe("{#a:resp-abc:p0 FOLDED}");
		expect(foldTag("r:call-xyz")).toBe("{#r:call-xyz FOLDED}");
	});
});

describe("digest tag", () => {
	const kinds: BlockKind[] = ["user", "text", "thinking", "tool_call", "tool_result"];

	it("prepends the {#<id> FOLDED} tag for every kind", () => {
		for (const kind of kinds) {
			const b = blk({ id: `a:${kind}:p0`, kind, toolName: "grep", callId: "c1" });
			const d = digest(b);
			expect(d.startsWith(`{#a:${kind}:p0 FOLDED} `)).toBe(true);
		}
	});

	it("carries the exact durable id so the agent can pass it back to unfold", () => {
		const b = blk({ id: "r:call-xyz", kind: "tool_result", toolName: "bash", text: "line1\nline2" });
		expect(digest(b)).toContain("{#r:call-xyz FOLDED}");
	});

	it("keeps the per-kind body after the tag (tag is additive, not a replacement)", () => {
		const b = blk({ id: "a:r1:p0", kind: "text", text: "the assistant concluded the fix is correct" });
		const d = digest(b);
		expect(d).toContain("the assistant concluded");
	});
});

describe("digestTokens includes the tag cost", () => {
	it("accounts for the tag, so token math matches what the agent receives", () => {
		const b = blk({ id: "a:resp-abc:p0", kind: "text", text: "x".repeat(400) });
		// digestTokens must equal estTokens(full tagged digest) + overhead — i.e. it counts
		// the tag, not just the body. (Regression guard against re-introducing a wire-only
		// tag that the engine under-counts.)
		const expected = estTokens(digest(b)) + BLOCK_OVERHEAD;
		expect(digestTokens(b)).toBe(expected);
		// And the tagged digest is strictly larger than the bare body would be.
		expect(digest(b).length).toBeGreaterThan("{#a:resp-abc:p0 FOLDED} ".length);
	});
});
