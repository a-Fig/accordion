import { describe, expect, it } from "vitest";
import type { Block, Group } from "../../engine/types";
import { blockPreview, groupSummaryMeta, groupTurnRange, turnLabel } from "./groupSummary";

function block(id: string, kind: Block["kind"], turn: number, text = "hello world"): Block {
	return {
		id,
		kind,
		turn,
		order: 0,
		text,
		tokens: 100,
		override: null,
		autoFolded: false,
		by: null,
	};
}

describe("group summary UI helpers", () => {
	it("builds collapsed group metadata from digest and members", () => {
		const group: Group = { id: "g:a", memberIds: ["a", "b", "c"], folded: true };
		const members = [
			block("a", "user", 1),
			block("b", "tool_call", 2),
			block("c", "tool_result", 2),
		];

		expect(groupSummaryMeta(group, members, "{#abc123 FOLDED} group digest", 1200)).toEqual({
			status: "folded group",
			memberCount: 3,
			turnRange: "turns 1-2",
			savedTokens: 1200,
			digest: "{#abc123 FOLDED} group digest",
			kinds: ["user", "tool_call", "tool_result"],
		});
	});

	it("formats preamble and same-turn ranges", () => {
		expect(turnLabel(0)).toBe("preamble");
		expect(groupTurnRange([block("a", "text", 0), block("b", "text", 0)])).toBe("preamble");
		expect(groupTurnRange([block("a", "text", 0), block("b", "text", 3)])).toBe("preamble-turn 3");
	});

	it("normalizes and clips member previews", () => {
		expect(blockPreview(block("a", "text", 1, "  one\n two\tthree  "))).toBe("one two three");
		expect(blockPreview(block("b", "text", 1, "abcdefghijklmnopqrstuvwxyz"), 10)).toBe("abcdefg...");
	});
});
