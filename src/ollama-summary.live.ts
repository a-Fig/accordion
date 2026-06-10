import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
	DEFAULT_OLLAMA_MODEL,
	createAccordionState,
	createOllamaSummaryProvider,
	deterministicDigest,
	contentHash,
	parseMessages,
	runConductor,
	type AccordionState,
	type AgentMessage,
} from "./conductor.ts";

const txt = (text: string) => ({ type: "text", text });

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, text: string): AgentMessage {
	return { id, role: "assistant", content: [txt(text)] };
}

function big(label: string, tokens: number): string {
	return Array.from({ length: tokens }, (_, i) => `${label}_${i}`).join(" ");
}

function textOfMessage(message: AgentMessage): string {
	const content = (message as any).content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content.map((part) => part.text ?? part.thinking ?? JSON.stringify(part)).join("\n");
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const start = performance.now();
	while (performance.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function makeLiveMessages(): AgentMessage[] {
	return [
		user("u1", "Capture the old parser and API error context."),
		assistant(
			"a1",
			[
				"The old context says parseMessages preserves toolCall arguments, app.tsx references,",
				"and TypeError: Cannot read properties of undefined in src/conductor.ts.",
				big("old_summary_source", 120),
			].join(" "),
		),
		user("u2", "Continue with the current implementation."),
		assistant("a2", big("fresh_tail_context", 5_200)),
		user("u3", "next"),
	];
}

function firstFoldedTarget(messages: AgentMessage[]) {
	const target = parseMessages(messages).blocks.find((block) => block.turn === 1 && block.kind === "text");
	assert.ok(target);
	return target;
}

test("live Ollama summaries cache asynchronously and timeout fallback stays safe", async () => {
	const model = process.env.OLLAMA_SUMMARY_MODEL ?? DEFAULT_OLLAMA_MODEL;
	const messages = makeLiveMessages();
	const target = firstFoldedTarget(messages);
	const hash = contentHash(target);
	const digest = deterministicDigest(target);
	const state = createAccordionState({ foldedBlockIds: [target.id] });

	const start = performance.now();
	const output = runConductor(
		{
			messages,
			incomingPrompt: "next",
			lastCompletedTurn: null,
			budgetTokens: 200_000,
			state,
		},
		{
			summaryProvider: createOllamaSummaryProvider({ model, timeoutMs: 90_000 }),
		},
	);
	const contextReturnMs = performance.now() - start;

	assert.match(textOfMessage(output.messages[1]), new RegExp(digest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(contextReturnMs < 250, `context return took ${contextReturnMs.toFixed(1)}ms`);

	await waitFor(() => typeof state.summaryCache[hash] === "string", 120_000, "Ollama summary cache");
	const summaryCompleteMs = performance.now() - start;
	const summary = state.summaryCache[hash];
	assert.ok(summary.length > 10);

	const timeoutState: AccordionState = createAccordionState({ foldedBlockIds: [target.id] });
	const timeoutStart = performance.now();
	const timeoutOutput = runConductor(
		{
			messages,
			incomingPrompt: "next",
			lastCompletedTurn: null,
			budgetTokens: 200_000,
			state: timeoutState,
		},
		{
			summaryProvider: createOllamaSummaryProvider({ model, timeoutMs: 1 }),
		},
	);
	const timeoutContextReturnMs = performance.now() - timeoutStart;
	assert.match(textOfMessage(timeoutOutput.messages[1]), new RegExp(digest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	await waitFor(() => timeoutState.pendingSummaryHashes.length === 0, 10_000, "timed-out provider cleanup");
	const timeoutSettleMs = performance.now() - timeoutStart;
	assert.equal(timeoutState.summaryCache[hash], undefined);

	console.log(
		JSON.stringify(
			{
				model,
				contextReturnMs: Number(contextReturnMs.toFixed(1)),
				summaryCompleteMs: Number(summaryCompleteMs.toFixed(1)),
				timeoutContextReturnMs: Number(timeoutContextReturnMs.toFixed(1)),
				timeoutSettleMs: Number(timeoutSettleMs.toFixed(1)),
				summaryHash: hash,
				summaryChars: summary.length,
			},
			null,
			2,
		),
	);
});
