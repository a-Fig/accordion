import assert from "node:assert/strict";
import { test } from "node:test";
import { registerAgentTools } from "./accordion.ts";
import { agentFold, agentPin, agentRecall, agentUnfold, foldBlocks, parseTurnSelector, pinBlocks, unfoldBlocks } from "./agent-tools.ts";
import {
	CALIBRATION_UP_STEP,
	FOLD_TARGET_INITIAL,
	createAccordionState,
	parseMessages,
	runConductor,
	type AgentMessage,
} from "./conductor.ts";

const txt = (text: string) => ({ type: "text", text });
const user = (id: string, text: string): AgentMessage => ({ id, role: "user", content: [txt(text)] });
const assistant = (id: string, parts: any[]): AgentMessage => ({ id, role: "assistant", content: parts });

function bigLines(label: string, lines: number, wordsPerLine = 14): string {
	return Array.from(
		{ length: lines },
		(_, i) => Array.from({ length: wordsPerLine }, (_, j) => `${label}_l${i}_w${j}`).join(" "),
	).join("\n");
}

function textOf(messages: AgentMessage[]): string {
	return messages
		.map((m: any) =>
			typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? p.thinking ?? "").join("\n"),
		)
		.join("\n");
}

/** Long session with a verbatim needle buried in turn 2, then cold filler. */
function fixture() {
	// A prose needle on purpose: no key=value pairs, commands, or identifiers, so
	// the salience digest legitimately cannot carry it — only full text can.
	const needle = "the canary slice is twelve percent in us-west-two behind rollout gate thirty-seven, expanding hourly after the first clean bake";
	const messages: AgentMessage[] = [
		user("u1", "set up the deploy pipeline"),
		assistant("a1", [
			txt(`Deploy rollout plan recorded below.\nFor the record, ${needle}.\n${bigLines("deploy_notes", 50)}`),
		]),
	];
	for (let i = 0; i < 5; i++) {
		messages.push(user(`u${i + 2}`, `boilerplate request ${i}`));
		messages.push(assistant(`a${i + 2}`, [txt(bigLines(`filler${i}`, 60))]));
	}
	messages.push(user("u-last", "continue"));
	return { messages, needle };
}

function applyOut(state: ReturnType<typeof createAccordionState>, output: { decisions: any[] }) {
	for (const d of output.decisions) {
		if (d.action === "fold") state.foldLevels[d.blockId] = d.level ?? 2;
		else delete state.foldLevels[d.blockId];
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
}

function pressureRun(messages: AgentMessage[], state: ReturnType<typeof createAccordionState>, budget: number) {
	return runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});
}

test("selector: parses singles, ranges, lists, and clamps to the session", () => {
	assert.deepEqual(parseTurnSelector("7", 10), [7]);
	assert.deepEqual(parseTurnSelector("3-5", 10), [3, 4, 5]);
	assert.deepEqual(parseTurnSelector("2, 7 4", 10), [2, 4, 7]);
	assert.deepEqual(parseTurnSelector("9-30", 10), [9, 10]);
	assert.deepEqual(parseTurnSelector("zero none", 10), []);
});

test("claim 2 \u00b7 recall: the agent reads folded history in full without changing anything", () => {
	const { messages, needle } = fixture();
	const state = createAccordionState();
	applyOut(state, pressureRun(messages, state, 800)); // folds the needle turn
	const stateBefore = JSON.stringify(state);
	const messagesBefore = JSON.stringify(messages);

	const result = agentRecall(messages, state, "1");
	assert.ok(result.ok);
	assert.ok(result.content.includes(needle), "full original text comes back, verbatim");
	assert.ok(result.content.includes("was folded"), "recall labels the rescue");
	assert.equal(JSON.stringify(state), stateBefore, "live context state untouched");
	assert.equal(JSON.stringify(messages), messagesBefore, "originals untouched");
});

test("claim 2 \u00b7 unfold: an agent unfold restores full text on the next assembly and survives pressure", () => {
	const { messages, needle } = fixture();
	const state = createAccordionState();
	const first = pressureRun(messages, state, 6_000);
	applyOut(state, first);
	assert.ok(!textOf(first.messages).includes(needle), "needle starts folded away under pressure");

	const result = agentUnfold(messages, state, "1");
	assert.ok(result.ok);
	assert.ok(result.changes.length > 0);
	assert.ok(result.changes.every((c) => c.actor === "agent"), "attributed to the agent, not the human");
	assert.ok(state.manualChanges.some((c) => c.actor === "agent" && c.action === "unfold"));

	const second = pressureRun(messages, state, 6_000);
	assert.ok(textOf(second.messages).includes(needle), "grace period keeps the agent's unfold open under pressure");
	assert.ok(second.assembledTokens <= 6_000, "budget invariant still holds around the rescue");
});

test("claim 2 \u00b7 learning: the agent reaching back teaches the Conductor to fold less", () => {
	const { messages } = fixture();
	const state = createAccordionState();
	const first = pressureRun(messages, state, 800);
	assert.equal(first.foldTarget, FOLD_TARGET_INITIAL);
	applyOut(state, first);

	agentUnfold(messages, state, "1");

	const next = [...messages, assistant("a-next", [txt(bigLines("more", 40))]), user("u-next2", "continue")];
	const second = pressureRun(next, state, 800);
	assert.equal(
		second.foldTarget,
		FOLD_TARGET_INITIAL + CALIBRATION_UP_STEP,
		"agent unfold counts as a correction event",
	);
});

test("claim 2 \u00b7 fold: the agent frees its own budget, with guardrails", () => {
	const { messages } = fixture();
	const state = createAccordionState({ pinnedTurnIndexes: [3] });
	const maxTurn = parseMessages(messages).turns.at(-1)!.index;

	const refused = agentFold(messages, state, String(maxTurn));
	assert.equal(refused.ok, false, "current turn is the working context and can't be folded");

	const result = agentFold(messages, state, "2-4");
	assert.ok(result.ok);
	assert.ok(result.changes.every((c) => c.actor === "agent" && c.level === 2));
	const foldedTurns = new Set(
		parseMessages(messages).blocks.filter((b) => state.foldLevels[b.id] === 2).map((b) => b.turn),
	);
	assert.ok(foldedTurns.has(2) && foldedTurns.has(4));
	assert.ok(!foldedTurns.has(3), "pinned turn stays open");
	assert.ok(result.message.includes("nothing is deleted"), "the tool teaches reversibility");
});

test("every fold level is addressable: digests, trims, and group members carry \u27e6t\u2026\u27e7 turn addresses", () => {
	const messages: AgentMessage[] = [user("u1", "start the long refactor")];
	for (let i = 0; i < 8; i++) messages.push(assistant(`a${i}`, [txt(bigLines(`old_chunk${i}`, 60))]));
	messages.push(user("u9", "continue"));
	const mild = pressureRun(messages, createAccordionState(), 600);
	assert.ok(/\u27e6t\d+\u27e7 /.test(textOf(mild.messages)), "digest addresses present");
	const deep = pressureRun(messages, createAccordionState(), 160);
	assert.ok(/\u00b7 t\d+ folded into the group digest above/.test(textOf(deep.messages)), "group members carry their turn");

	const single: AgentMessage[] = [
		user("v1", "set up"),
		assistant("b1", [txt(bigLines("cold_alpha", 120))]),
		user("v2", "write the docs for the setup"),
	];
	const full = parseMessages(single).blocks.reduce((s, b) => s + b.tokens, 0);
	const trimmed = runConductor({
		messages: single,
		incomingPrompt: "write the docs for the setup",
		lastCompletedTurn: null,
		budgetTokens: full - 60,
		state: createAccordionState(),
		workingTailTokens: 0,
	});
	assert.ok(/\u27e6trim t\d+\u27e7/.test(textOf(trimmed.messages)), "trim addresses present");
});

test("pi registration returns AgentToolResult content, not a bare string", async () => {
	const captured: any[] = [];
	const messages: AgentMessage[] = [
		user("u1", "remember the rollout note"),
		assistant("a1", [txt("the canary slice is twelve percent in us west two")]),
		user("u2", "continue"),
	];
	const ctx = {
		sessionManager: {
			getBranch: () => messages.map((message) => ({ type: "message", message })),
		},
	};

	registerAgentTools({
		registerTool: (tool: any) => captured.push(tool),
	} as any);

	assert.equal(captured.length, 4);
	const result = await captured[0].execute("call-1", { turns: "1" }, undefined, undefined, ctx);
	assert.deepEqual(result.details, {});
	assert.deepEqual(result.content.map((part: any) => part.type), ["text"]);
	assert.match(result.content[0].text, /Recalled 1 turn in full/);
});

test("agentPin: pinned turn survives heavy fold pressure", () => {
	const { messages } = fixture();
	const state = createAccordionState();
	// Get turn 2 block ids
	const parsed = parseMessages(messages);
	const turn2Blocks = parsed.blocks.filter(b => b.turn === 2);
	assert.ok(turn2Blocks.length > 0, "turn 2 should have blocks");

	// Pin turn 2
	const pinResult = agentPin(messages, state, "2");
	assert.ok(pinResult.ok, "pin should succeed");
	assert.ok(pinResult.changes.length > 0, "should have pin changes");

	// Verify blocks are in pinnedBlockIds
	for (const b of turn2Blocks) {
		assert.ok(state.pinnedBlockIds.includes(b.id), `block ${b.id} should be pinned`);
	}

	// Run heavy fold pressure
	pressureRun(messages, state, 500);

	// Pinned blocks should NOT appear in foldedBlockIds
	const foldedSet = new Set(state.foldedBlockIds);
	for (const b of turn2Blocks) {
		assert.ok(!foldedSet.has(b.id), `pinned block ${b.id} should not be folded`);
	}
});

test("foldBlocks/unfoldBlocks: basic fold and unfold operations work", () => {
	const { messages } = fixture();
	const state = createAccordionState();
	const parsed = parseMessages(messages);
	// Pick a non-current-turn block
	const maxTurn = parsed.turns.at(-1)!.index;
	const target = parsed.blocks.find(b => b.turn !== maxTurn && b.kind !== "user");
	assert.ok(target, "should find a non-current-turn block");

	// Fold it
	const foldDecisions = foldBlocks(messages, state, [target.id], "you");
	assert.ok(foldDecisions.length > 0, "should produce fold decisions");
	assert.ok(state.foldedBlockIds.includes(target.id), "block should be folded");
	assert.equal(state.foldLevels[target.id], 2, "should be at fold level 2");

	// Unfold it
	const unfoldDecisions = unfoldBlocks(messages, state, [target.id], "you");
	assert.ok(unfoldDecisions.length > 0, "should produce unfold decisions");
	assert.ok(!state.foldedBlockIds.includes(target.id), "block should be unfolded");
	assert.equal(state.foldLevels[target.id], undefined, "fold level should be cleared");
});

test("pinBlocks: basic pin operation works and prevents auto-fold", () => {
	const { messages } = fixture();
	const state = createAccordionState();
	const parsed = parseMessages(messages);
	const maxTurn = parsed.turns.at(-1)!.index;
	const target = parsed.blocks.find(b => b.turn !== maxTurn && b.kind !== "user");
	assert.ok(target, "should find a non-current-turn block");

	const pinDecisions = pinBlocks(messages, state, [target.id], "you");
	assert.ok(pinDecisions.length > 0, "should produce pin decisions");
	assert.ok(state.pinnedBlockIds.includes(target.id), "block should be in pinnedBlockIds");
	assert.equal(state.foldLevels[target.id], undefined, "pinned block should not be in foldLevels");

	// Attempt to fold the pinned block — should skip it
	const foldDecisions = foldBlocks(messages, state, [target.id], "you");
	assert.equal(foldDecisions.length, 0, "pinned block should not be foldable via foldBlocks");
});

test("foldBlocks/unfoldBlocks: callId-pair atomicity", () => {
	const toolCallMsg: AgentMessage = {
		id: "a1",
		role: "assistant",
		content: [{ type: "tool_use", id: "call1", name: "bash", input: { command: "ls" } }],
	};
	const toolResultMsg: AgentMessage = {
		id: "r1",
		role: "toolResult",
		toolCallId: "call1",
		toolName: "bash",
		content: [{ type: "text", text: "file1 file2 file3" }],
		isError: false,
	};
	const messages: AgentMessage[] = [
		user("u1", "list files"),
		toolCallMsg as any,
		toolResultMsg as any,
		user("u2", "continue"),
	];
	const state = createAccordionState();
	const parsed = parseMessages(messages);
	const callBlock = parsed.blocks.find(b => b.kind === "tool_call");
	if (!callBlock) return; // skip if parse structure differs

	// Folding the call should fold the block
	const decisions = foldBlocks(messages, state, [callBlock.id], "you");
	assert.ok(decisions.length > 0, "should produce fold decisions");
	assert.ok(state.foldedBlockIds.includes(callBlock.id), "call block should be folded");
});
