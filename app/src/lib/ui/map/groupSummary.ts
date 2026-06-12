import type { Block, Group } from "../../engine/types";

export const BLOCK_KIND_LABEL: Record<Block["kind"], string> = {
	user: "User",
	text: "Reply",
	thinking: "Thinking",
	tool_call: "Tool call",
	tool_result: "Tool result",
};

export interface GroupSummaryMeta {
	status: "folded group" | "live group";
	memberCount: number;
	turnRange: string;
	savedTokens: number;
	digest: string;
	kinds: Block["kind"][];
}

export function turnLabel(turn: number): string {
	return turn === 0 ? "preamble" : `turn ${turn}`;
}

export function groupTurnRange(members: Block[]): string {
	if (members.length === 0) return "";
	const first = members[0].turn;
	const last = members[members.length - 1].turn;
	if (first === last) return turnLabel(first);
	if (first === 0) return `preamble-turn ${last}`;
	return `turns ${first}-${last}`;
}

export function blockPreview(block: Block, max = 120): string {
	const text = block.text.replace(/\s+/g, " ").trim();
	if (!text) return "(empty)";
	return text.length > max ? text.slice(0, Math.max(0, max - 3)).trimEnd() + "..." : text;
}

export function groupSummaryMeta(
	group: Group,
	members: Block[],
	digest: string,
	savedTokens: number,
): GroupSummaryMeta {
	return {
		status: group.folded ? "folded group" : "live group",
		memberCount: members.length,
		turnRange: groupTurnRange(members),
		savedTokens,
		digest,
		kinds: members.map((member) => member.kind),
	};
}
