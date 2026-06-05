import { describe, it, expect } from "vitest";
import { linearize, applyPlan, type PiMessage } from "./mapping";
import type { FoldOp } from "./protocol";

// A small but representative pi context: a user turn, an assistant turn that
// thinks + replies + calls a tool, and the tool's result.
function sample(): PiMessage[] {
	return [
		{ role: "user", content: "fix the bug" },
		{
			role: "assistant",
			model: "kimi",
			content: [
				{ type: "thinking", thinking: "let me look at the file and reason about it" },
				{ type: "text", text: "I'll read the file." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: "line1\nline2\nline3", isError: false },
	];
}

describe("linearize", () => {
	it("splits an assistant message into its parts and ids encode location", () => {
		const blocks = linearize(sample());
		expect(blocks.map((b) => [b.id, b.kind])).toEqual([
			["m0:u", "user"],
			["m1:p0", "thinking"],
			["m1:p1", "text"],
			["m1:p2", "tool_call"],
			["m2:r", "tool_result"],
		]);
	});

	it("links a tool_call to its result by callId", () => {
		const blocks = linearize(sample());
		const call = blocks.find((b) => b.kind === "tool_call")!;
		const result = blocks.find((b) => b.kind === "tool_result")!;
		expect(call.callId).toBe("call_1");
		expect(result.callId).toBe("call_1");
	});

	it("increments turn on user messages and assigns dense order", () => {
		const blocks = linearize(sample());
		expect(blocks.every((b) => b.turn === 1)).toBe(true);
		expect(blocks.map((b) => b.order)).toEqual([0, 1, 2, 3, 4]);
	});

	it("drops empty non-result parts but keeps empty tool results", () => {
		const msgs: PiMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "" }] },
			{ role: "toolResult", toolCallId: "c", toolName: "t", content: "" },
		];
		const blocks = linearize(msgs);
		expect(blocks.map((b) => b.kind)).toEqual(["tool_result"]);
	});
});

describe("applyPlan", () => {
	it("empty plan returns the same array (identity)", () => {
		const msgs = sample();
		const out = applyPlan(msgs, []);
		expect(out).toBe(msgs);
	});

	it("is pure — never mutates the caller's messages", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const before = JSON.parse(JSON.stringify(msgs));
		const out = applyPlan(msgs, [{ id: "m1:p1", digestText: "text digest" }]);
		expect(msgs).toEqual(before); // input untouched
		expect(out).not.toBe(msgs); // a new array
		expect((out[1].content as any[])[1].text).toBe("text digest"); // fold is in the output
	});

	it("folds a tool_result's content but keeps its pairing fields", () => {
		// add filler messages so the result is outside the recent-message backstop
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const out = applyPlan(msgs, [{ id: "m2:r", digestText: "read → 3 lines" }]);
		const tr = out[2];
		expect(tr.content).toEqual([{ type: "text", text: "read → 3 lines" }]);
		expect(tr.toolCallId).toBe("call_1"); // pairing preserved
		expect(tr.toolName).toBe("read");
	});

	it("replaces thinking/text and never folds a tool_call", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const ops: FoldOp[] = [
			{ id: "m1:p0", digestText: "thought digest" },
			{ id: "m1:p1", digestText: "text digest" },
			{ id: "m1:p2", digestText: "SHOULD BE IGNORED" }, // tool_call — must not change
		];
		const out = applyPlan(msgs, ops);
		const parts = out[1].content as any[];
		expect(parts[0].thinking).toBe("thought digest");
		expect(parts[1].text).toBe("text digest");
		expect(parts[2]).toEqual({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } });
	});

	it("ignores an op whose id maps to a wrong-kind or missing part", () => {
		const msgs: PiMessage[] = [
			...sample(),
			{ role: "user", content: "next" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		// m1:p2 is a tool_call (wrong kind for a content fold); m1:p9 does not exist
		const out = applyPlan(msgs, [
			{ id: "m1:p2", digestText: "nope" },
			{ id: "m1:p9", digestText: "nope" },
		]);
		expect(out).toBe(msgs); // nothing applied → original array returned
	});

	it("backstop: refuses to fold the most-recent messages", () => {
		// here the tool_result is within the last PROTECT_RECENT_MSGS, so the op is ignored
		const msgs = sample();
		const out = applyPlan(msgs, [{ id: "m2:r", digestText: "folded!" }]);
		expect(out).toBe(msgs); // no change → identity
		expect(msgs[2].content).toBe("line1\nline2\nline3"); // untouched
	});
});
