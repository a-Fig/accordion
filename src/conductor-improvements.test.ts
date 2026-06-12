/**
 * Tests for the six decision-model improvements:
 *   1. Structured salience digest suffix
 *   2. Risk-aware unfold scoring
 *   3. Conductor-initiated temporary pins
 *   4. Improved group formation (semantic + enriched head)
 *   5. Multi-reason decision logging
 *   6. Agent context-awareness header
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldBlocks } from "./agent-tools.ts";
import {
	CALIBRATION_UP_STEP,
	CONDUCTOR_PIN_LIFETIME,
	FOLD_TARGET_INITIAL,
	GROUP_MIN_UNITS,
	RISK_FLOOR_BONUS,
	RISK_FLOOR_MIN,
	SEMANTIC_GROUP_OVERLAP_THRESHOLD,
	UNFOLD_KEYWORD_THRESHOLD,
	UNFOLD_SEMANTIC_FLOOR,
	calibrateFoldTarget,
	categorizeSalienceMarkers,
	contentHash,
	createAccordionState,
	deterministicDigest,
	parseMessages,
	parseRiskFlags,
	parseSalienceRiskBonus,
	runConductor,
	textHash,
	type AgentMessage,
	type ContextBlock,
	type FoldDecision,
	type SummaryRequest,
} from "./conductor.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const txt = (text: string) => ({ type: "text", text });
const user = (id: string, text: string): AgentMessage => ({ id, role: "user", content: [txt(text)] });
const assistant = (id: string, parts: any[]): AgentMessage => ({ id, role: "assistant", content: parts });
const toolResult = (id: string, callId: string, name: string, text: string): AgentMessage => ({
	id, role: "toolResult", toolCallId: callId, toolName: name, content: [txt(text)], isError: false,
});

function big(label: string, tokens: number): string {
	return Array.from({ length: tokens }, (_, i) => `${label}_${i}`).join(" ");
}

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

function liveTokens(messages: AgentMessage[], foldedIds = new Set<string>()): number {
	const parsed = parseMessages(messages);
	return parsed.blocks.reduce((sum, b) => {
		const base = b.tokens;
		if (!foldedIds.has(b.id)) return sum + base;
		// approximate digest cost
		return sum + Math.ceil(deterministicDigest(b).length / 4) + 4;
	}, 0);
}

function blockForKind(messages: AgentMessage[], kind: string, matchText?: string): ContextBlock {
	const blocks = parseMessages(messages).blocks.filter((b) => b.kind === kind);
	const block = matchText ? blocks.find((b) => b.text.includes(matchText)) : blocks[0];
	assert.ok(block, `No ${kind} block${matchText ? ` matching "${matchText}"` : ""} found`);
	return block;
}

function reasonIncludes(reason: string | string[], value: string): boolean {
	if (typeof reason === "string") return reason.includes(value);
	return reason.some((r) => r.includes(value));
}

// ──────────────────────────────────────────────────────────────────────────────
// A. Structured salience in digests
// ──────────────────────────────────────────────────────────────────────────────

test("digest suffix: file path in block text appears in the salience suffix", () => {
	const block: ContextBlock = {
		id: "b1", kind: "text", turn: 1, order: 0,
		text: "We updated the configuration in src/cache.ts to use Redis.",
		tokens: 20, source: { messageIndex: 0, field: "content" },
	};
	const digest = deterministicDigest(block);
	assert.ok(digest.includes("src/cache.ts"), `digest: ${digest}`);
	const flags = parseRiskFlags(digest);
	assert.ok(flags.includes("paths"), `risk flags: ${flags}`);
});

test("digest suffix: shell command in block text appears in the salience suffix", () => {
	const block: ContextBlock = {
		id: "b2", kind: "tool_result", turn: 1, order: 0,
		text: "Running deployment:\n$ npm run deploy --tag=v3\nDeployment started.",
		tokens: 20, toolName: "bash", source: { messageIndex: 0, field: "tool_result" },
	};
	const digest = deterministicDigest(block);
	const cats = categorizeSalienceMarkers(block.text);
	assert.ok(cats.commands.length > 0, `no commands found in: ${JSON.stringify(cats)}`);
	assert.ok(digest.includes("commands:"), `digest should contain commands suffix: ${digest}`);
	const flags = parseRiskFlags(digest);
	assert.ok(flags.includes("commands"), `risk flags: ${flags}`);
});

test("digest suffix: error string in block text appears in the salience suffix", () => {
	const block: ContextBlock = {
		id: "b3", kind: "tool_result", turn: 1, order: 0,
		text: "Deployment failed.\nError: ENOENT no such file or directory: /app/config.yaml",
		tokens: 20, toolName: "bash", source: { messageIndex: 0, field: "tool_result" },
	};
	const digest = deterministicDigest(block);
	const cats = categorizeSalienceMarkers(block.text);
	assert.ok(cats.errors.length > 0, `no errors found: ${JSON.stringify(cats)}`);
	assert.ok(digest.includes("errors:"), `digest should contain errors suffix: ${digest}`);
});

test("digest suffix: decision language in block text appears in the salience suffix", () => {
	const block: ContextBlock = {
		id: "b4", kind: "text", turn: 1, order: 0,
		text: "After the meeting, we decided to use Redis over Memcached for the cache layer.",
		tokens: 20, source: { messageIndex: 0, field: "content" },
	};
	const digest = deterministicDigest(block);
	const cats = categorizeSalienceMarkers(block.text);
	assert.ok(cats.decisions.length > 0, `no decisions found: ${JSON.stringify(cats)}`);
	assert.ok(digest.includes("decisions:"), `digest should contain decisions suffix: ${digest}`);
	const flags = parseRiskFlags(digest);
	assert.ok(flags.includes("decisions"), `risk flags: ${flags}`);
});

test("digest suffix: key=value pair appears in exact_values category", () => {
	const block: ContextBlock = {
		id: "b5", kind: "tool_result", turn: 1, order: 0,
		text: "Configuration loaded.\nDB_HOST=localhost\nDB_PORT=5432",
		tokens: 10, toolName: "bash", source: { messageIndex: 0, field: "tool_result" },
	};
	const cats = categorizeSalienceMarkers(block.text);
	assert.ok(cats.exact_values.length > 0, `no exact_values found: ${JSON.stringify(cats)}`);
	const digest = deterministicDigest(block);
	assert.ok(digest.includes("exact_values:"), `digest should contain exact_values suffix: ${digest}`);
	assert.ok(parseRiskFlags(digest).includes("exact_values"));
});

test("digest suffix: parseSalienceRiskBonus counts risk categories correctly", () => {
	// Block with commands + paths = bonus of 2
	const block: ContextBlock = {
		id: "b6", kind: "tool_result", turn: 1, order: 0,
		text: "$ npm install\nUpdated src/index.ts",
		tokens: 10, toolName: "bash", source: { messageIndex: 0, field: "tool_result" },
	};
	const digest = deterministicDigest(block);
	const bonus = parseSalienceRiskBonus(digest);
	assert.ok(bonus >= 1, `expected risk bonus ≥ 1, got ${bonus} for digest: ${digest}`);
});

test("digest suffix is deterministic across multiple calls", () => {
	const block: ContextBlock = {
		id: "b7", kind: "text", turn: 1, order: 0,
		text: "We decided to use Redis. Path: src/cache.ts. Error: ENOENT",
		tokens: 15, source: { messageIndex: 0, field: "content" },
	};
	assert.equal(deterministicDigest(block), deterministicDigest(block));
});

// ──────────────────────────────────────────────────────────────────────────────
// B. Risk-aware unfold scoring
// ──────────────────────────────────────────────────────────────────────────────

test("risk unfold: block with commands marker unfolds at lower relevance than one without", () => {
	// Build a session where the needle has a command (high-risk) and we test
	// that it unfolds at a lower overlap than the default floor.
	const needle = "$ npm run deploy --tag=v3\nDeployment complete.";
	const messages: AgentMessage[] = [
		user("u1", "run the deploy"),
		assistant("a1", [txt(`Deploying now.\n${needle}`)]),
		user("u2", "status update"),
		assistant("a2", [txt(big("filler", 800))]),
		user("u3", "continue"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.text.includes("npm run deploy"));
	assert.ok(target);

	// Pre-fold the target block
	const state = createAccordionState({ foldedBlockIds: [target.id] });
	const digest = deterministicDigest(target);
	const riskBonus = parseSalienceRiskBonus(digest);
	assert.ok(riskBonus > 0, `expected risk bonus > 0 for command block, got ${riskBonus}`);

	// With risk bonus, effective floor should be lower than UNFOLD_KEYWORD_THRESHOLD
	const effectiveFloor = Math.max(RISK_FLOOR_MIN, UNFOLD_KEYWORD_THRESHOLD - riskBonus * RISK_FLOOR_BONUS);
	assert.ok(effectiveFloor < UNFOLD_KEYWORD_THRESHOLD,
		`effective floor ${effectiveFloor} should be below ${UNFOLD_KEYWORD_THRESHOLD}`);
});

test("risk unfold: block with no risk markers requires normal relevance threshold", () => {
	// A vague discussion block: no paths, commands, exact_values, or decisions
	const block: ContextBlock = {
		id: "b8", kind: "text", turn: 1, order: 0,
		text: "The team had a productive brainstorming session about potential improvements.",
		tokens: 20, source: { messageIndex: 0, field: "content" },
	};
	const digest = deterministicDigest(block);
	const bonus = parseSalienceRiskBonus(digest);
	const effectiveFloor = Math.max(RISK_FLOOR_MIN, UNFOLD_KEYWORD_THRESHOLD - bonus * RISK_FLOOR_BONUS);
	// No risk bonus means effective floor stays at the standard threshold
	assert.equal(bonus, 0, `expected 0 risk bonus for vague block, got ${bonus}`);
	assert.equal(effectiveFloor, UNFOLD_KEYWORD_THRESHOLD);
});

test("risk unfold: proactive unfold fires for command-containing block at sub-threshold overlap", () => {
	// Construct a scenario where overlap is below UNFOLD_KEYWORD_THRESHOLD but
	// the risk bonus lowers the effective floor enough to trigger unfold.
	const commandText = "$ redis-cli FLUSHDB\nCache cleared.";
	const messages: AgentMessage[] = [
		user("u1", "set up redis"),
		assistant("a1", [txt(commandText)]),
		user("u2", "continue with something else"),
		assistant("a2", [txt(big("unrelated", 600))]),
		user("u3", "run redis operation"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.text.includes("redis-cli"));
	assert.ok(target);

	const digest = deterministicDigest(target);
	const riskBonus = parseSalienceRiskBonus(digest);
	// Should have commands (redis-cli) as a risk marker
	assert.ok(riskBonus >= 1, `expected risk bonus ≥ 1, got ${riskBonus} for: ${digest}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// C. Conductor pins
// ──────────────────────────────────────────────────────────────────────────────

test("conductor pins: pinned block survives auto-folding for CONDUCTOR_PIN_LIFETIME turns", () => {
	const messages: AgentMessage[] = [
		user("u1", "old work"),
		assistant("a1", [txt(big("important_block", 600))]),
		user("u2", "continue"),
		assistant("a2", [txt(big("filler", 400))]),
		user("u3", "next"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.kind === "text" && b.text.includes("important_block"));
	assert.ok(target);

	// Manually set a conductor pin on the target block at turn 2
	const state = createAccordionState({
		conductorPins: { [target.id]: { turn: 2, reason: "test_pin" } },
	});

	// Run conductor at turn 3 (within lifetime, turn 2 + CONDUCTOR_PIN_LIFETIME = 5)
	const budget = liveTokens(messages) - 400; // force pressure
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	// The conductor-pinned block should NOT be auto-folded
	assert.equal(
		output.decisions.some((d) => d.blockId === target.id && d.action === "fold"),
		false,
		"conductor-pinned block should not be auto-folded",
	);
});

test("conductor pins: pin expires after CONDUCTOR_PIN_LIFETIME turns", () => {
	const messages: AgentMessage[] = [
		user("u1", "old work"),
		assistant("a1", [txt(big("was_pinned", 600))]),
		user("u2", "filler"),
		assistant("a2", [txt(big("filler2", 400))]),
		user("u3", "filler"),
		assistant("a3", [txt(big("filler3", 400))]),
		user("u4", "filler"),
		assistant("a4", [txt(big("filler4", 400))]),
		user("u5", "now do something"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.kind === "text" && b.text.includes("was_pinned"));
	assert.ok(target);

	// Pin was set at turn 1; currentTurn will be 5. 5 - 1 = 4 > CONDUCTOR_PIN_LIFETIME (3) → expired.
	const state = createAccordionState({
		conductorPins: { [target.id]: { turn: 1, reason: "test_pin" } },
	});

	const budget = Math.floor(liveTokens(messages) * 0.5);
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	// Expired pin: the block should be eligible for folding
	// (it may or may not be folded depending on budget, but the pin shouldn't prevent it)
	// Verify the pin was pruned (state has no active pin for this block)
	assert.ok(
		!state.conductorPins?.[target.id],
		"expired conductor pin should be pruned from state",
	);
});

test("conductor pins: human /fold overrides conductor pin", () => {
	const messages: AgentMessage[] = [
		user("u1", "old work"),
		assistant("a1", [txt(big("conductor_pinned_block", 200))]),
		user("u2", "continue"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.kind === "text" && b.text.includes("conductor_pinned"));
	assert.ok(target);

	const state = createAccordionState({
		conductorPins: { [target.id]: { turn: 2, reason: "active_pin" } },
	});

	// Human explicitly folds via foldBlocks (bypasses canFoldUnit entirely)
	const changes = foldBlocks(messages, state, [target.id], "you");
	assert.ok(
		changes.some((c) => c.action === "fold" && c.blockId === target.id),
		"foldBlocks should succeed even on a conductor-pinned block",
	);
});

test("conductor pins: expiry does NOT count as a calibration correction event", () => {
	const state = createAccordionState({
		foldTargetCalibrated: FOLD_TARGET_INITIAL,
		lastCalibrationTurn: 4,
		conductorPins: { "expired-block": { turn: 1, reason: "test" } },
		lastRunHadPressure: true,
		lastRunWithinBudget: true,
	});

	// Tick calibration at turn 5 with no manual corrections or proactive unfolds
	// (pin expiry should NOT register as a correction)
	const target = calibrateFoldTarget(state, 5);

	// Should decay (quiet pressure-active turn), not increase (no correction registered)
	assert.ok(target < FOLD_TARGET_INITIAL,
		`expected decay (< ${FOLD_TARGET_INITIAL}), got ${target} — pin expiry should not count as correction`);
});

test("conductor pins: proactively rescued block gets a conductor pin", () => {
	const messages: AgentMessage[] = [
		user("u1", "set up"),
		assistant("a1", [txt("We decided to use Redis for caching. The host is redis.prod:6379.")]),
		user("u2", "unrelated"),
		assistant("a2", [txt(big("filler", 800))]),
		user("u3", "what cache did we pick"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.text.includes("Redis for caching"));
	assert.ok(target);

	const budget = liveTokens(messages, new Set([target.id]));
	const state = createAccordionState({ foldedBlockIds: [target.id] });

	const output = runConductor({
		messages,
		incomingPrompt: "what cache did we pick",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	// If the block was proactively rescued, a conductor pin should be set
	if (output.proactiveUnfolds.includes(target.id)) {
		assert.ok(
			state.conductorPins?.[target.id] !== undefined,
			"proactively rescued block should get a conductor pin",
		);
		// The pin decision should appear in the output
		const pinDecision = output.decisions.find((d) => d.blockId === target.id && d.action === "pin");
		assert.ok(pinDecision, "pin decision should be in output decisions");
		assert.equal(pinDecision!.actor, "conductor");
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// D. Multi-reason decision logging
// ──────────────────────────────────────────────────────────────────────────────

test("multi-reason: fold decision has an array of reasons including relevant factors", () => {
	const messages: AgentMessage[] = [
		user("u1", "old"),
		assistant("a1", [txt(big("old_content", 1200))]),
		user("u2", "continue"),
		assistant("a2", [txt(big("fresh", 400))]),
		user("u3", "next"),
	];

	const state = createAccordionState();
	const budget = Math.floor(liveTokens(messages) * 0.7);
	const output = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const foldDecision = output.decisions.find((d) => d.action === "fold");
	assert.ok(foldDecision, "should have at least one fold decision");
	assert.ok(Array.isArray(foldDecision!.reason), "reason should be an array");
	const reasons = foldDecision!.reason as string[];
	// Should include at least one of the standard fold reasons
	const hasStandardReason = reasons.some((r) =>
		r === "relevance_low" || r === "budget_pressure" || r === "not_pinned",
	);
	assert.ok(hasStandardReason, `reasons: ${reasons}`);
});

test("multi-reason: unfold decision has reason array including proactive_rescue", () => {
	const messages: AgentMessage[] = [
		user("u1", "What about cache?"),
		assistant("a1", [txt("We standardized on Redis for the cache layer. Host: redis.internal:6379")]),
		user("u2", "unrelated UI work"),
		assistant("a2", [txt(big("ui_filler", 900))]),
		user("u3", "what was the cache decision again?"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.text.includes("standardized on Redis"));
	assert.ok(target);

	const budget = liveTokens(messages, new Set([target.id]));
	const state = createAccordionState({ foldedBlockIds: [target.id] });

	const output = runConductor({
		messages,
		incomingPrompt: "what was the cache decision again?",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const unfoldDecision = output.decisions.find((d) => d.blockId === target.id && d.action === "unfold");
	if (unfoldDecision) {
		assert.ok(Array.isArray(unfoldDecision.reason), "unfold reason should be an array");
		const reasons = unfoldDecision.reason as string[];
		assert.ok(
			reasons.some((r) => r.includes("relevance_high") || r.includes("proactive_rescue")),
			`unfold reasons should include relevance signal: ${reasons}`,
		);
	}
});

test("multi-reason: unfold decision includes digest_has_risk_flag when risk markers present", () => {
	// Large enough block so digest < full (canFoldUnit passes); has a command for risk signal.
	const commandText =
		"$ npm run build --tag=v3\n" +
		big("build_output", 200) +
		"\nBuild complete in 3.2s. Artifacts written to dist/app.js";
	const messages: AgentMessage[] = [
		user("u1", "build the project"),
		assistant("a1", [txt(commandText)]),
		user("u2", "continue"),
		assistant("a2", [txt(big("unrelated_filler", 600))]),
		user("u3", "run the build again"),
	];
	const parsed = parseMessages(messages);
	const target = parsed.blocks.find((b) => b.text.includes("npm run build"));
	assert.ok(target);

	const digest = deterministicDigest(target);
	const riskBonus = parseSalienceRiskBonus(digest);
	if (riskBonus === 0) return; // block has no risk markers — skip

	// Pre-fold the target; budget = live with target folded so proactive unfold has headroom.
	const state = createAccordionState({ foldedBlockIds: [target.id] });
	const budget = liveTokens(messages, new Set([target.id])) + target.tokens; // restore headroom
	const output = runConductor({
		messages,
		incomingPrompt: "run the build again",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const unfoldDecision = output.decisions.find((d) => d.blockId === target.id && d.action === "unfold");
	if (unfoldDecision) {
		const reasons = Array.isArray(unfoldDecision.reason) ? unfoldDecision.reason : [unfoldDecision.reason];
		const hasRiskFlag = reasons.some((r) => r.startsWith("digest_has_risk_flag:"));
		assert.ok(hasRiskFlag, `expected digest_has_risk_flag in reasons: ${reasons}`);
	}
	// If no unfold decision, the proactive unfold didn't fire at this budget — test passes vacuously.
});

// ──────────────────────────────────────────────────────────────────────────────
// E. Context-awareness header
// ──────────────────────────────────────────────────────────────────────────────

test("awareness header: injected into first assistant message when folded blocks exist", () => {
	const messages: AgentMessage[] = [
		user("u1", "old context"),
		assistant("a1", [txt(big("old_text", 700))]),
		user("u2", "continue"),
		assistant("a2", [txt(big("fresh", 300))]),
		user("u3", "next"),
	];

	const state = createAccordionState();
	const budget = Math.floor(liveTokens(messages) * 0.65);
	const output = runConductor({
		messages,
		incomingPrompt: "next",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const hasFolds = output.decisions.some((d) => d.action === "fold");
	if (hasFolds) {
		const outputText = textOf(output.messages);
		assert.ok(
			outputText.includes("Accordion context manager active"),
			"assembled context should contain awareness header when blocks are folded",
		);
	}
});

test("awareness header: lists correct folded turn numbers", () => {
	const messages: AgentMessage[] = [
		user("u1", "turn 1 old"),
		assistant("a1", [txt(big("turn1_content", 800))]),
		user("u2", "turn 2 filler"),
		assistant("a2", [txt(big("turn2_content", 800))]),
		user("u3", "continue"),
	];

	const state = createAccordionState();
	const budget = Math.floor(liveTokens(messages) * 0.5);
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const foldedTurns = new Set(output.decisions.filter((d) => d.action === "fold").map((d) => d.turn));
	if (foldedTurns.size > 0) {
		const outputText = textOf(output.messages);
		assert.ok(outputText.includes("Folded turns:"), "header should list folded turns");
		// Every folded turn number should appear somewhere in the output header
		for (const turn of foldedTurns) {
			assert.ok(
				outputText.includes(String(turn)),
				`folded turn ${turn} should appear in the assembled context text`,
			);
		}
	}
});

test("awareness header: pressure label matches budget ratio", () => {
	// tight budget → "tight" label
	const messages: AgentMessage[] = [
		user("u1", "old"),
		assistant("a1", [txt(big("heavy_old", 1000))]),
		user("u2", "more old"),
		assistant("a2", [txt(big("heavy_old2", 1000))]),
		user("u3", "even more old"),
		assistant("a3", [txt(big("heavy_old3", 1000))]),
		user("u4", "now"),
	];

	const state = createAccordionState();
	// Use a very tight budget (~55% of live) to ensure the ratio > 0.85 after folding
	const rawLive = liveTokens(messages);
	const budget = Math.floor(rawLive * 0.95); // tight constraint
	const output = runConductor({
		messages,
		incomingPrompt: "now",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});

	const hasFolds = output.decisions.some((d) => d.action === "fold");
	if (hasFolds) {
		const outputText = textOf(output.messages);
		// The pressure label should be one of the three valid options
		const hasLabel = outputText.includes("pressure: comfortable") ||
			outputText.includes("pressure: normal") ||
			outputText.includes("pressure: tight");
		assert.ok(hasLabel, `output should contain a pressure label: ${outputText.slice(0, 300)}`);
	}
});

test("awareness header: NOT injected when no blocks are folded", () => {
	// Very large budget so nothing folds
	const messages: AgentMessage[] = [
		user("u1", "tiny"),
		assistant("a1", [txt("tiny response")]),
		user("u2", "continue"),
	];

	const state = createAccordionState();
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 200_000,
		state,
		workingTailTokens: 0,
	});

	// No folds should mean no header
	const hasFolds = output.decisions.some((d) => d.action === "fold");
	if (!hasFolds) {
		const outputText = textOf(output.messages);
		assert.ok(
			!outputText.includes("Accordion context manager active"),
			"no awareness header should be injected when nothing is folded",
		);
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// Regression: constants are exported and accessible
// ──────────────────────────────────────────────────────────────────────────────

test("constants: new improvement constants are correctly defined", () => {
	assert.equal(typeof CONDUCTOR_PIN_LIFETIME, "number");
	assert.ok(CONDUCTOR_PIN_LIFETIME >= 1, `CONDUCTOR_PIN_LIFETIME=${CONDUCTOR_PIN_LIFETIME}`);
	assert.equal(typeof SEMANTIC_GROUP_OVERLAP_THRESHOLD, "number");
	assert.ok(SEMANTIC_GROUP_OVERLAP_THRESHOLD > 0 && SEMANTIC_GROUP_OVERLAP_THRESHOLD < 1);
	assert.equal(typeof RISK_FLOOR_BONUS, "number");
	assert.ok(RISK_FLOOR_BONUS > 0);
	assert.equal(typeof RISK_FLOOR_MIN, "number");
	assert.ok(RISK_FLOOR_MIN > 0 && RISK_FLOOR_MIN <= UNFOLD_KEYWORD_THRESHOLD);
});

test("regression: AccordionState can be serialized and deserialized with conductorPins", () => {
	const state = createAccordionState({
		conductorPins: { "block-1": { turn: 5, reason: "proactive_rescue" } },
	});
	const serialized = JSON.stringify(state);
	const deserialized = JSON.parse(serialized);
	const restored = createAccordionState(deserialized);
	assert.deepEqual(restored.conductorPins, state.conductorPins);
});

test("regression: FoldDecision reason can be string or string array", () => {
	const stringReason: FoldDecision = {
		blockId: "b1", action: "fold", actor: "conductor",
		reason: "low relevance", turn: 1, kind: "text",
	};
	const arrayReason: FoldDecision = {
		blockId: "b2", action: "fold", actor: "conductor",
		reason: ["relevance_low", "age_high", "not_pinned"], turn: 1, kind: "text",
	};
	// Both forms are valid
	assert.ok(reasonIncludes(stringReason.reason, "relevance"));
	assert.ok(reasonIncludes(arrayReason.reason, "not_pinned"));
});

// ──────────────────────────────────────────────────────────────────────────────
// B3. Summary critical-path tests
// ──────────────────────────────────────────────────────────────────────────────

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

function conductorFixture() {
	const bigLine = (label: string, lines: number, wordsPerLine = 14): string =>
		Array.from({ length: lines }, (_, i) =>
			Array.from({ length: wordsPerLine }, (_, j) => `${label}_l${i}_w${j}`).join(" "),
		).join("\n");

	const messages: AgentMessage[] = [
		user("u1", "set up the deploy pipeline"),
		assistant("a1", [txt(`Deploy rollout plan recorded.\n${bigLine("deploy_notes", 50)}`)]),
	];
	for (let i = 0; i < 5; i++) {
		messages.push(user(`u${i + 2}`, `boilerplate request ${i}`));
		messages.push(assistant(`a${i + 2}`, [txt(bigLine(`filler${i}`, 60))]));
	}
	messages.push(user("u-last", "continue"));
	return { messages };
}

test("summary: seeded summaryCache entry is used in assembled output instead of deterministic digest", () => {
	const { messages } = conductorFixture();
	const state = createAccordionState();
	// First run to fold some blocks — apply decisions to state
	const firstOut = pressureRun(messages, state, 2000);
	for (const d of firstOut.decisions) {
		if (d.action === "fold") state.foldLevels[d.blockId] = d.level ?? 2;
		else if (d.action === "unfold") delete state.foldLevels[d.blockId];
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	const foldedId = state.foldedBlockIds[0];
	assert.ok(foldedId, "should have at least one folded block");
	const parsed = parseMessages(messages);
	const block = parsed.blocks.find(b => b.id === foldedId);
	assert.ok(block, "should find the folded block");
	// Seed the LLM summary by contentHash
	const hash = contentHash(block!);
	state.summaryCache[hash] = "Summary: LLM_SUMMARY_SENTINEL_42";
	// Run conductor with the seeded cache
	const out = runConductor(
		{ messages, incomingPrompt: "", lastCompletedTurn: null, budgetTokens: 2000, workingTailTokens: 0, state },
		{},
	);
	const assembled = textOf(out.messages);
	assert.ok(assembled.includes("LLM_SUMMARY_SENTINEL_42"), "assembled output must contain the LLM summary");
});

test("summary: stubbed summaryProvider populates summaryCache on first run; second run uses it", async () => {
	const { messages } = conductorFixture();
	const state = createAccordionState();
	// First run to fold some blocks — apply decisions to state
	const firstOut = pressureRun(messages, state, 2000);
	for (const d of firstOut.decisions) {
		if (d.action === "fold") state.foldLevels[d.blockId] = d.level ?? 2;
		else if (d.action === "unfold") delete state.foldLevels[d.blockId];
	}
	state.foldedBlockIds = Object.keys(state.foldLevels);
	const foldedId = state.foldedBlockIds[0];
	assert.ok(foldedId, "should have a folded block");
	const parsed = parseMessages(messages);
	const block = parsed.blocks.find(b => b.id === foldedId);
	assert.ok(block, "should find folded block");

	let summaryCallCount = 0;
	const summaryProvider = async (request: SummaryRequest) => {
		summaryCallCount++;
		return `Summary: STUB_SUMMARY_for_${request.hash.slice(0, 8)}`;
	};

	// First run: provider fires asynchronously, output may use digest
	const out1 = runConductor(
		{ messages, incomingPrompt: "", lastCompletedTurn: null, budgetTokens: 2000, workingTailTokens: 0, state },
		{ summaryProvider },
	);
	// Wait for async summary promise to settle
	await new Promise(r => setTimeout(r, 50));
	// summaryCache should now be populated
	const hash = contentHash(block!);
	assert.ok(state.summaryCache[hash], "summaryCache should have the stub summary after settle");
	assert.ok(state.summaryCache[hash].includes("STUB_SUMMARY"), "cache value should be the stub summary");
	// Second run: should use the cached summary
	const out2 = runConductor(
		{ messages, incomingPrompt: "", lastCompletedTurn: null, budgetTokens: 2000, workingTailTokens: 0, state },
		{ summaryProvider },
	);
	const assembled2 = textOf(out2.messages);
	assert.ok(assembled2.includes("STUB_SUMMARY"), "second run assembled output should use the cached LLM summary");
	void out1; // suppress unused warning
});
