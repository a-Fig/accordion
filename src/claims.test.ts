import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAccordionState,
	deterministicDigest,
	parseMessages,
	runConductor,
	textHash,
	type AgentMessage,
} from "./conductor.ts";

const txt = (text: string) => ({ type: "text", text });

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, parts: any[]): AgentMessage {
	return { id, role: "assistant", content: parts };
}

function result(id: string, callId: string, text: string): AgentMessage {
	return {
		id,
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [txt(text)],
		isError: false,
	};
}

function big(label: string, tokens: number): string {
	return Array.from({ length: tokens }, (_, i) => `${label}_${i}`).join(" ");
}

function textOf(messages: AgentMessage[]): string {
	return messages
		.map((message: any) => {
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map((part: any) => part.text ?? part.thinking ?? JSON.stringify(part)).join("\n");
		})
		.join("\n");
}

function tokensOf(messages: AgentMessage[]): number {
	return parseMessages(messages).blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function claimMessages(): AgentMessage[] {
	return [
		user("u-old", "Investigate the old deployment logs."),
		assistant("a-old", [
			{ type: "text", text: "The final rollback route is POST /v3/admin/bulk-invites." },
			{ type: "toolCall", id: "call-old", name: "bash", arguments: { command: "cat deploy.log" } },
		]),
		result("r-old", "call-old", `${big("cold_log_noise", 2_200)}\nFINAL_MARKER=MANGO-WHISPER-9`),
		user("u-mid", "Continue the implementation."),
		assistant("a-mid", [{ type: "thinking", thinking: big("middle_reasoning", 800) }]),
		user("u-tail", "Now finish the docs."),
		assistant("a-tail", [{ type: "text", text: big("fresh_tail", 300) }]),
		user("u-now", "next"),
	];
}

function assertNoOrphanedToolPairs(messages: AgentMessage[]): void {
	const parsed = parseMessages(messages);
	const calls = new Set(parsed.blocks.filter((b) => b.kind === "tool_call" && b.callId).map((b) => b.callId));
	const results = new Set(parsed.blocks.filter((b) => b.kind === "tool_result" && b.callId).map((b) => b.callId));
	for (const id of calls) assert.ok(results.has(id), `tool_call ${id} has no tool_result`);
	for (const id of results) assert.ok(calls.has(id), `tool_result ${id} has no tool_call`);
}

test("claim: Accordion enforces an equal token budget on the assembled context", () => {
	const messages = claimMessages();
	const state = createAccordionState();
	const budgetTokens = 2_500;
	const output = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens,
		state,
		workingTailTokens: 0,
	});

	assert.ok(tokensOf(output.messages) <= budgetTokens, `${tokensOf(output.messages)} > ${budgetTokens}`);
	assert.ok(output.decisions.some((d) => d.action === "fold"), "budget proof should exercise at least one fold");
});

test("claim: folding is a reversible view and never mutates the original session messages", () => {
	const messages = claimMessages();
	const before = JSON.stringify(messages);
	const state = createAccordionState();
	const oldResult = parseMessages(messages).blocks.find((b) => b.kind === "tool_result" && b.callId === "call-old");
	assert.ok(oldResult);

	const folded = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: 2_500,
		state,
		workingTailTokens: 0,
	});
	assert.equal(JSON.stringify(messages), before, "runConductor must not mutate stored originals");
	assert.match(textOf(folded.messages), new RegExp(deterministicDigest(oldResult).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const restored = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: 200_000,
		state: createAccordionState({ foldedBlockIds: [] }),
		workingTailTokens: 0,
	});
	assert.match(textOf(restored.messages), /FINAL_MARKER=MANGO-WHISPER-9/);
	assert.equal(JSON.stringify(messages), before, "unfold/restored view still leaves originals untouched");
});

test("claim: provider safety keeps tool calls and results structurally paired", () => {
	const messages = claimMessages();
	const state = createAccordionState();
	const output = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: 2_500,
		state,
		workingTailTokens: 0,
	});

	assertNoOrphanedToolPairs(output.messages);
	const pairActions = output.decisions.filter((d) => d.callId === "call-old" && d.action === "fold").map((d) => d.kind).sort();
	assert.deepEqual(pairActions, ["tool_call", "tool_result"], "tool pair should fold atomically");
});

test("claim: protected working tail is not folded automatically", () => {
	const messages = claimMessages();
	const parsed = parseMessages(messages);
	const tailBlock = parsed.blocks.find((b) => b.turn === 3 && b.kind === "text");
	assert.ok(tailBlock);

	const output = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: 1_600,
		state: createAccordionState(),
		workingTailTokens: 10_000,
	});

	assert.equal(output.decisions.some((d) => d.blockId === tailBlock.id && d.action === "fold"), false);
	assert.match(textOf(output.messages), /fresh_tail_0/);
});

test("claim: semantic relevance can proactively restore a folded block with no keyword overlap", () => {
	const messages = [
		user("u1", "Record the design review."),
		assistant("a1", [{ type: "text", text: "Maya quietly preferred the ivy layout after comparing several onboarding designs." }]),
		user("u2", "Continue."),
		assistant("a2", [{ type: "text", text: big("implementation_noise", 900) }]),
		user("u3", "Which arrangement did the reviewer like?"),
	];
	const target = parseMessages(messages).blocks.find((b) => b.kind === "text" && b.text.includes("ivy layout"));
	assert.ok(target);
	const prompt = "Which arrangement did the reviewer like?";
	const state = createAccordionState({
		foldedBlockIds: [target.id],
		embeddingCache: {
			[textHash(target.text)]: [1, 0],
			[textHash(prompt)]: [1, 0],
			[textHash("irrelevant")]: [0, 1],
		},
	});

	const output = runConductor({
		messages,
		incomingPrompt: prompt,
		lastCompletedTurn: null,
		budgetTokens: 200_000,
		state,
		workingTailTokens: 0,
	});

	assert.ok(
		output.proactiveUnfolds.includes(target.id) || output.decisions.some((d) => d.blockId === target.id && d.action === "unfold"),
		"semantic relevance should restore the folded target",
	);
	assert.match(textOf(output.messages), /ivy layout/);
});
