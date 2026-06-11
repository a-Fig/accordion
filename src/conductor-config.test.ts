import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_BUDGET_TOKENS,
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	DEFAULT_SUMMARY_TIMEOUT_MS,
	EMBEDDING_MODEL,
	FOLD_TARGET_INITIAL,
	FOLD_TARGET_MAX,
	FOLD_TARGET_MIN,
	SUMMARY_MODEL,
	WORKING_TAIL_TOKENS,
	calibrateFoldTarget,
	createAccordionState,
	defaultConductorConfig,
	mergeConductorConfig,
	parseMessages,
	runConductor,
	type AgentMessage,
} from "./conductor.ts";

const txt = (text: string) => ({ type: "text", text });

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, text: string): AgentMessage {
	return { id, role: "assistant", content: [{ type: "text", text }] };
}

function big(label: string, tokens: number): string {
	return Array.from({ length: tokens }, (_, i) => `${label}_${i}`).join(" ");
}

test("defaultConductorConfig returns values matching exported constants", () => {
	const config = defaultConductorConfig();
	assert.equal(config.budgetTokens, DEFAULT_BUDGET_TOKENS);
	assert.equal(config.workingTailTokens, WORKING_TAIL_TOKENS);
	assert.equal(config.foldTargetMin, FOLD_TARGET_MIN);
	assert.equal(config.foldTargetMax, FOLD_TARGET_MAX);
	assert.equal(config.foldTargetInitial, FOLD_TARGET_INITIAL);
	assert.equal(config.summaryModel, "");
	assert.equal(SUMMARY_MODEL, "claude-haiku-4-5");
	assert.equal(config.ollamaBaseUrl, DEFAULT_OLLAMA_BASE_URL);
	assert.equal(config.ollamaModel, DEFAULT_OLLAMA_MODEL);
	assert.equal(config.embeddingModel, EMBEDDING_MODEL);
	assert.equal(config.summariesEnabled, true);
	assert.equal(config.embeddingsEnabled, true);
	assert.equal(config.summaryTimeoutMs, DEFAULT_SUMMARY_TIMEOUT_MS);
});

test("createAccordionState with no seed has config matching defaults", () => {
	const state = createAccordionState();
	assert.deepEqual(state.config, defaultConductorConfig());
});

test("createAccordionState with partial config seed merges correctly", () => {
	const state = createAccordionState({
		config: { budgetTokens: 42_000, summariesEnabled: false },
	});
	assert.equal(state.config.budgetTokens, 42_000);
	assert.equal(state.config.summariesEnabled, false);
	assert.equal(state.config.workingTailTokens, WORKING_TAIL_TOKENS);
	assert.equal(state.config.embeddingModel, EMBEDDING_MODEL);
});

test("config survives JSON serialization round-trip", () => {
	const original = createAccordionState({
		config: { budgetTokens: 88_000, foldTargetMin: 0.65, embeddingsEnabled: true },
	});
	const restored = createAccordionState(JSON.parse(JSON.stringify(original)));
	assert.deepEqual(restored.config, original.config);
});

test("custom budgetTokens in config is respected through ConductorInput", () => {
	const state = createAccordionState({ config: { budgetTokens: 400 } });
	const messages: AgentMessage[] = [
		user("u1", "start"),
		assistant("a1", big("chunk", 200)),
		user("u2", "continue"),
	];
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: state.config.budgetTokens,
		state,
		workingTailTokens: 0,
	});
	assert.ok(output.assembledTokens <= state.config.budgetTokens);
	assert.ok(parseMessages(output.messages).blocks.length > 0);
});

test("custom foldTargetMax in config caps calibrated fold target", () => {
	const state = createAccordionState({
		config: { foldTargetMax: 0.7, foldTargetMin: 0.6, foldTargetInitial: 0.65 },
		foldTargetCalibrated: 0.65,
	});
	state.manualChanges = [
		{ blockId: "b1", action: "unfold", actor: "you", turn: 9 },
		{ blockId: "b2", action: "unfold", actor: "agent", turn: 9 },
	];
	state.lastCalibrationTurn = -1;
	const target = calibrateFoldTarget(state, 10);
	assert.ok(target <= 0.7);
	assert.ok(target >= 0.6);
});
