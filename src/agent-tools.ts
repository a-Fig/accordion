/**
 * Agent-side bidirectional memory.
 *
 * The tagline made executable: the agent can reach back into its own history,
 * not just receive whatever the system decides to show it. Three verbs:
 *
 *   recall — read folded turns in FULL without changing the live context
 *            (the agent's "peek"; the read path).
 *   unfold — restore folded turns to full text for the coming turns
 *            (the write-open path; counts as a correction for the calibrator,
 *            so the Conductor literally learns from the agent reaching back).
 *   fold   — push turns the agent is done with down to digests
 *            (the write-close path; the agent frees its own budget).
 *
 * Everything here is pure given (messages, state): the pi extension wires these
 * to model-callable tools, and tests exercise them directly.
 */

import {
	parseMessages,
	type AccordionState,
	type AgentMessage,
	type ContextBlock,
	type FoldDecision,
	type FoldLevel,
} from "./conductor.ts";

function expandToPair(blocks: ContextBlock[], blockId: string): ContextBlock[] {
	const b = blocks.find(x => x.id === blockId);
	if (!b) return [];
	if (!b.callId || (b.kind !== "tool_call" && b.kind !== "tool_result")) return [b];
	const pair = blocks.filter(x => x.callId === b.callId && (x.kind === "tool_call" || x.kind === "tool_result"));
	const calls = pair.filter(x => x.kind === "tool_call");
	const results = pair.filter(x => x.kind === "tool_result");
	return pair.length === 2 && calls.length === 1 && results.length === 1 ? pair.sort((a, z) => a.order - z.order) : [b];
}

function changeRecord2(
	block: ContextBlock,
	action: "fold" | "unfold" | "pin" | "unpin",
	level: FoldLevel,
	fromLevel: FoldLevel,
	currentTurn: number,
	reason: string,
): FoldDecision {
	return { blockId: block.id, action: action as FoldDecision["action"], actor: "agent", reason, turn: currentTurn, kind: block.kind, callId: block.callId, level, fromLevel };
}

export interface AgentToolOutcome {
	ok: boolean;
	/** One-line confirmation or error, written for the model to read. */
	message: string;
	turns: number[];
	/** Decision records (actor: "agent") for the persisted decision stream. */
	changes: FoldDecision[];
}

export interface AgentRecallOutcome extends AgentToolOutcome {
	/** Full original text of the requested turns, sectioned per turn. */
	content: string;
}

/** Parse "7", "3-5", "2,4,7", "3 5" into valid 1-based turn indexes. */
export function parseTurnSelector(input: string, maxTurn: number): number[] {
	const out = new Set<number>();
	for (const part of String(input ?? "").split(/[\s,]+/).filter(Boolean)) {
		const range = part.match(/^(\d+)\s*[-\u2013]\s*(\d+)$/);
		if (range) {
			const a = Number(range[1]);
			const b = Number(range[2]);
			for (let t = Math.min(a, b); t <= Math.max(a, b); t++) out.add(t);
		} else if (/^\d+$/.test(part)) {
			out.add(Number(part));
		}
	}
	return [...out].filter((t) => t >= 1 && t <= maxTurn).sort((a, b) => a - b);
}

function blocksForTurns(blocks: ContextBlock[], turns: number[]): ContextBlock[] {
	const wanted = new Set(turns);
	return blocks.filter((block) => wanted.has(block.turn));
}

function badSelector(selector: string, maxTurn: number): string {
	return `No valid turns in "${selector}". This session has turns 1\u2013${maxTurn}; pass e.g. "7", "3-5", or "2,7".`;
}

/** Read folded history without touching the live context. Pure read path. */
export function agentRecall(
	messages: AgentMessage[],
	state: AccordionState,
	selector: string,
	maxChars = 24_000,
): AgentRecallOutcome {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const turns = parseTurnSelector(selector, maxTurn);
	if (turns.length === 0) {
		return { ok: false, message: badSelector(selector, maxTurn), turns: [], changes: [], content: "" };
	}

	const sections = turns.map((turn) => {
		const blocks = blocksForTurns(parsed.blocks, [turn]);
		const folded = blocks.some((block) => (state.foldLevels[block.id] ?? 0) > 0);
		const body = blocks
			.map((block) => `[${block.kind}${block.toolName ? ` ${block.toolName}` : ""}]\n${block.text}`)
			.join("\n\n");
		return `=== turn ${turn}${folded ? " (was folded \u2014 full original below)" : ""} ===\n${body}`;
	});

	let content = sections.join("\n\n");
	if (content.length > maxChars) {
		content = `${content.slice(0, maxChars)}\n\u27ea\u2026 truncated; recall fewer turns for the rest \u2026\u27eb`;
	}
	return {
		ok: true,
		message: `Recalled ${turns.length} turn${turns.length === 1 ? "" : "s"} in full. The live context is unchanged.`,
		turns,
		changes: [],
		content,
	};
}

function changeRecord(
	block: ContextBlock,
	action: "fold" | "unfold",
	level: FoldLevel,
	fromLevel: FoldLevel,
	currentTurn: number,
	reason: string,
): FoldDecision {
	return {
		blockId: block.id,
		action,
		actor: "agent",
		reason,
		turn: currentTurn,
		kind: block.kind,
		callId: block.callId,
		level,
		fromLevel,
	};
}

/** Restore folded turns to full text. The agent's write-open path; a correction
 *  event, so the calibrated fold target opens on the next tick. */
export function agentUnfold(messages: AgentMessage[], state: AccordionState, selector: string): AgentToolOutcome {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const turns = parseTurnSelector(selector, maxTurn);
	if (turns.length === 0) return { ok: false, message: badSelector(selector, maxTurn), turns: [], changes: [] };

	const changes: FoldDecision[] = [];
	for (const block of blocksForTurns(parsed.blocks, turns)) {
		const level = (state.foldLevels[block.id] ?? 0) as FoldLevel;
		if (level === 0) continue;
		delete state.foldLevels[block.id];
		changes.push(changeRecord(block, "unfold", 0, level, maxTurn, "agent reached back"));
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(
		...changes.map((c) => ({ blockId: c.blockId, action: c.action, actor: c.actor as "agent", turn: c.turn })),
	);
	state.manualChanges = state.manualChanges.slice(-200);

	if (changes.length === 0) {
		return { ok: true, message: `Turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")} already in full \u2014 nothing to unfold.`, turns, changes };
	}
	return {
		ok: true,
		message: `Unfolded ${changes.length} block${changes.length === 1 ? "" : "s"} across turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")}. Full text is restored to your context from the next message, protected from auto-refold for one turn.`,
		turns,
		changes,
	};
}

/** Fold turns the agent no longer needs down to digests. Write-close path. */
export function agentFold(messages: AgentMessage[], state: AccordionState, selector: string): AgentToolOutcome {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const turns = parseTurnSelector(selector, maxTurn).filter((t) => t !== maxTurn);
	if (turns.length === 0) {
		return {
			ok: false,
			message: parseTurnSelector(selector, maxTurn).includes(maxTurn)
				? "The current turn can't be folded \u2014 it's your working context."
				: badSelector(selector, maxTurn),
			turns: [],
			changes: [],
		};
	}

	const pinnedTurns = new Set(state.pinnedTurnIndexes);
	const pinnedBlocks = new Set(state.pinnedBlockIds);
	const changes: FoldDecision[] = [];
	let pinnedSkipped = 0;
	for (const block of blocksForTurns(parsed.blocks, turns)) {
		if (pinnedTurns.has(block.turn) || pinnedBlocks.has(block.id)) {
			pinnedSkipped++;
			continue;
		}
		const fromLevel = (state.foldLevels[block.id] ?? 0) as FoldLevel;
		if (fromLevel >= 2) continue;
		state.foldLevels[block.id] = 2;
		changes.push(changeRecord(block, "fold", 2, fromLevel, maxTurn, "agent freed budget"));
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(
		...changes.map((c) => ({ blockId: c.blockId, action: c.action, actor: c.actor as "agent", turn: c.turn })),
	);
	state.manualChanges = state.manualChanges.slice(-200);

	const note = pinnedSkipped > 0 ? ` (${pinnedSkipped} pinned block${pinnedSkipped === 1 ? "" : "s"} left open)` : "";
	if (changes.length === 0) {
		return { ok: true, message: `Nothing new to fold in turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")}${note}.`, turns, changes };
	}
	return {
		ok: true,
		message: `Folded ${changes.length} block${changes.length === 1 ? "" : "s"} across turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")} to digests${note}. Recall or unfold them anytime \u2014 nothing is deleted.`,
		turns,
		changes,
	};
}

export function foldBlocks(
	messages: AgentMessage[],
	state: AccordionState,
	blockIds: string[],
	actor: string = "you",
): FoldDecision[] {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const pinnedBlocks = new Set(state.pinnedBlockIds);
	const changes: FoldDecision[] = [];
	for (const id of blockIds) {
		const unit = expandToPair(parsed.blocks, id);
		for (const b of unit) {
			if (pinnedBlocks.has(b.id) || b.turn === maxTurn) continue;
			const fromLevel = (state.foldLevels[b.id] ?? 0) as FoldLevel;
			if (fromLevel >= 2) continue;
			state.foldLevels[b.id] = 2;
			changes.push(changeRecord2(b, "fold", 2, fromLevel, maxTurn, "app command"));
		}
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(...changes.map(c => ({ blockId: c.blockId, action: c.action as "fold"|"unfold", actor: actor as "you"|"agent", turn: c.turn })));
	state.manualChanges = state.manualChanges.slice(-200);
	return changes;
}

export function unfoldBlocks(
	messages: AgentMessage[],
	state: AccordionState,
	blockIds: string[],
	actor: string = "you",
): FoldDecision[] {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const changes: FoldDecision[] = [];
	for (const id of blockIds) {
		const unit = expandToPair(parsed.blocks, id);
		for (const b of unit) {
			const level = (state.foldLevels[b.id] ?? 0) as FoldLevel;
			if (level === 0) continue;
			delete state.foldLevels[b.id];
			changes.push(changeRecord2(b, "unfold", 0, level, maxTurn, "app command"));
		}
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(...changes.map(c => ({ blockId: c.blockId, action: "unfold" as const, actor: actor as "you"|"agent", turn: c.turn })));
	state.manualChanges = state.manualChanges.slice(-200);
	return changes;
}

export function pinBlocks(
	messages: AgentMessage[],
	state: AccordionState,
	blockIds: string[],
	actor: string = "you",
): FoldDecision[] {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const changes: FoldDecision[] = [];
	for (const id of blockIds) {
		const unit = expandToPair(parsed.blocks, id);
		for (const b of unit) {
			if (!state.pinnedBlockIds.includes(b.id)) state.pinnedBlockIds.push(b.id);
			const fromLevel = (state.foldLevels[b.id] ?? 0) as FoldLevel;
			delete state.foldLevels[b.id];
			changes.push(changeRecord2(b, "pin", 0, fromLevel, maxTurn, "app command"));
		}
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	// pin decisions use action "pin" \u2014 push a synthetic unfold to manualChanges for calibrator
	state.manualChanges.push(...changes.map(c => ({ blockId: c.blockId, action: "unfold" as const, actor: actor as "you"|"agent", turn: c.turn })));
	state.manualChanges = state.manualChanges.slice(-200);
	return changes;
}

export function unpinBlocks(
	messages: AgentMessage[],
	state: AccordionState,
	blockIds: string[],
	actor: string = "you",
): FoldDecision[] {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const changes: FoldDecision[] = [];
	for (const id of blockIds) {
		const before = state.pinnedBlockIds.length;
		state.pinnedBlockIds = state.pinnedBlockIds.filter(x => x !== id);
		if (state.pinnedBlockIds.length !== before) {
			const b = parsed.blocks.find(x => x.id === id);
			if (b) changes.push(changeRecord2(b, "unpin", 0, 0, maxTurn, "app command"));
		}
	}
	return changes;
}

export function agentPin(messages: AgentMessage[], state: AccordionState, selector: string): AgentToolOutcome {
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)?.index ?? 0;
	const turns = parseTurnSelector(selector, maxTurn);
	if (turns.length === 0) return { ok: false, message: badSelector(selector, maxTurn), turns: [], changes: [] };

	const changes: FoldDecision[] = [];
	for (const block of blocksForTurns(parsed.blocks, turns)) {
		if (!state.pinnedBlockIds.includes(block.id)) state.pinnedBlockIds.push(block.id);
		const fromLevel = (state.foldLevels[block.id] ?? 0) as FoldLevel;
		delete state.foldLevels[block.id];
		changes.push(changeRecord2(block, "pin", 0, fromLevel, maxTurn, "agent pinned"));
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	state.manualChanges.push(
		...changes.map(c => ({ blockId: c.blockId, action: "unfold" as const, actor: "agent" as const, turn: c.turn })),
	);
	state.manualChanges = state.manualChanges.slice(-200);

	if (changes.length === 0) {
		return { ok: true, message: `Turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")} already pinned \u2014 nothing changed.`, turns, changes };
	}
	return {
		ok: true,
		message: `Pinned ${changes.length} block${changes.length === 1 ? "" : "s"} across turn${turns.length === 1 ? "" : "s"} ${turns.join(", ")}. They will stay full for the rest of the session.`,
		turns,
		changes,
	};
}

/** Tool definitions the pi extension registers when the host supports it.
 *  The descriptions are the agent's instruction manual \u2014 they teach the model
 *  that folded context is addressable and recoverable. */
export const AGENT_TOOL_DEFS = [
	{
		name: "accordion_recall",
		description:
			"Read the FULL original text of earlier turns in this session. Older context may appear folded into one-line digests marked like \u27e6t7\u27e7 \u2026, \u27e6trim t7\u27e7 \u2026, or \u00b7 t7 folded into the group digest above. When a digest references something you need verbatim \u2014 an exact command, code, an error, a config value, a decision \u2014 recall that turn instead of guessing. This does NOT change the live context.",
		parameters: {
			type: "object",
			properties: {
				turns: { type: "string", description: 'Turn numbers from the \u27e6t\u2026\u27e7 markers: "7", "3-5", or "2,7".' },
			},
			required: ["turns"],
		},
	},
	{
		name: "accordion_unfold",
		description:
			"Restore earlier folded turns (\u27e6t7\u27e7-style digests) to FULL text in your live context for the upcoming turns. Use when you'll keep working with that material. This also teaches Accordion's Conductor to fold less aggressively. Originals are always preserved; nothing is ever deleted.",
		parameters: {
			type: "object",
			properties: {
				turns: { type: "string", description: 'Turn numbers to restore: "7", "3-5", or "2,7".' },
			},
			required: ["turns"],
		},
	},
	{
		name: "accordion_fold",
		description:
			"Fold earlier turns you are finished with down to one-line digests to free context budget for upcoming work. Reversible at any time via accordion_recall / accordion_unfold; pinned turns stay open and the current turn can't be folded.",
		parameters: {
			type: "object",
			properties: {
				turns: { type: "string", description: 'Turn numbers to fold: "7", "3-5", or "2,7".' },
			},
			required: ["turns"],
		},
	},
	{
		name: "accordion_pin",
		description:
			"Pin earlier turns so Accordion will NEVER auto-fold them — they stay full in your context for the rest of the session. Use when the user says to remember, keep, not lose, or don't forget something. Do NOT recall and restate the content into a new message — pin the original turn so it stays open automatically. Pinned turns survive heavy fold pressure and compact events.",
		parameters: {
			type: "object",
			properties: {
				turns: { type: "string", description: 'Turn numbers to pin permanently open: "7", "3-5", or "2,7".' },
			},
			required: ["turns"],
		},
	} as const,
] as const;
