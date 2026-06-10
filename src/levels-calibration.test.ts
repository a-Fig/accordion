import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CALIBRATION_DOWN_STEP,
	CALIBRATION_UP_STEP,
	FOLD_TARGET_INITIAL,
	FOLD_TARGET_MAX,
	FOLD_TARGET_MIN,
	GROUP_MIN_UNITS,
	calibrateFoldTarget,
	createAccordionState,
	parseMessages,
	runConductor,
	trimmedText,
	type AgentMessage,
} from "./conductor.ts";

const txt = (text: string) => ({ type: "text", text });

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, parts: any[]): AgentMessage {
	return { id, role: "assistant", content: parts };
}

/** Multi-line filler so trim's structured-excerpt path (head/salience/tail) engages. */
function bigLines(label: string, lines: number, wordsPerLine = 14): string {
	return Array.from(
		{ length: lines },
		(_, i) => Array.from({ length: wordsPerLine }, (_, j) => `${label}_l${i}_w${j}`).join(" "),
	).join("\n");
}

function liveTextTokens(messages: AgentMessage[]): number {
	return parseMessages(messages).blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function textOf(messages: AgentMessage[]): string {
	return messages
		.map((message: any) =>
			typeof message.content === "string"
				? message.content
				: (message.content ?? [])
						.map((part: any) => part.text ?? part.thinking ?? "")
						.join("\n"),
		)
		.join("\n");
}

test("graduated fold: the marginal unit stops at trim instead of digest", () => {
	const cold = bigLines("cold_alpha", 120);
	const messages = [
		user("u1", "set up the project"),
		assistant("a1", [txt(cold)]),
		user("u2", "write the docs for the setup"),
	];
	const full = liveTextTokens(messages);
	// Need (live - target) small enough that trimming the cold block suffices.
	const budget = full - 60;
	const state = createAccordionState();
	const output = runConductor({
		messages,
		incomingPrompt: "write the docs for the setup",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	});
	const foldDecisions = output.decisions.filter((d) => d.action === "fold");
	assert.ok(foldDecisions.length >= 1);
	assert.ok(foldDecisions.every((d) => d.level === 1), "marginal fold should stop at trim");
	assert.ok(output.assembledTokens <= budget);
	const assembled = textOf(output.messages);
	assert.ok(assembled.includes("\u27e6trim t"), "trim marker present");
	assert.ok(assembled.includes("cold_alpha_l0_w0"), "trim keeps the head");
	assert.ok(assembled.includes("cold_alpha_l119_w13"), "trim keeps the tail");
	assert.ok(!assembled.includes("cold_alpha_l60_w7"), "trim elides the middle bulk");
});

test("graduated fold: escalates past trim to digest when trim cannot cover the need", () => {
	const cold = bigLines("cold_beta", 120);
	const messages = [
		user("u1", "set up the project"),
		assistant("a1", [txt(cold)]),
		user("u2", "write the docs for the setup"),
	];
	const budget = 300;
	const output = runConductor({
		messages,
		incomingPrompt: "write the docs for the setup",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state: createAccordionState(),
		workingTailTokens: 0,
	});
	const foldDecisions = output.decisions.filter((d) => d.action === "fold");
	assert.ok(foldDecisions.some((d) => d.level === 2), "deep need escalates to digest");
	assert.ok(output.assembledTokens <= budget);
});

test("graduated fold: deep pressure collapses contiguous digests into a group", () => {
	const messages: AgentMessage[] = [user("u1", "start the long refactor")];
	for (let i = 0; i < 8; i++) {
		messages.push(assistant(`a${i}`, [txt(bigLines(`old_chunk${i}`, 60))]));
	}
	messages.push(user("u9", "continue"));
	const budget = 160;
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: budget,
		state: createAccordionState(),
		workingTailTokens: 0,
	});
	const grouped = output.decisions.filter((d) => d.action === "fold" && d.level === 3);
	assert.ok(grouped.length >= GROUP_MIN_UNITS - 1, "group members folded to markers");
	const assembled = textOf(output.messages);
	assert.ok(assembled.includes("\u27e6group \u00b7 turns"), "group head carries the group digest");
	assert.ok(assembled.includes("folded into the group digest above"));
	assert.ok(output.assembledTokens <= budget);
});

test("graduated fold: levels are a view; original messages are never mutated", () => {
	const messages: AgentMessage[] = [user("u1", "start")];
	for (let i = 0; i < 8; i++) {
		messages.push(assistant(`a${i}`, [txt(bigLines(`keep_chunk${i}`, 60))]));
	}
	messages.push(user("u9", "continue"));
	const snapshot = JSON.stringify(messages);
	const output = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 160,
		state: createAccordionState(),
		workingTailTokens: 0,
	});
	const levelsUsed = new Set(output.decisions.map((d) => d.level));
	assert.ok(levelsUsed.size >= 2, "fixture exercises multiple fold levels");
	assert.equal(JSON.stringify(messages), snapshot, "originals untouched at every level");
});

test("trim keeps salience tokens from the middle of the block", () => {
	const middleFact = "DEPLOY_KEY=MANGO-WHISPER-9";
	const text = `${bigLines("pre", 40)}\n${middleFact}\n${bigLines("post", 40)}`;
	const block = parseMessages([user("u1", "x"), assistant("a1", [txt(text)]), user("u2", "y")]).blocks[1];
	const trimmed = trimmedText(block);
	assert.ok(trimmed.includes("MANGO-WHISPER-9"), "salience hoists the buried identifier");
	assert.ok(trimmed.length < text.length * 0.5);
});

test("calibrator: corrections raise the target asymmetrically and idempotently", () => {
	const state = createAccordionState({
		manualChanges: [
			{ blockId: "a", action: "unfold", actor: "you", turn: 8 },
			{ blockId: "b", action: "unfold", actor: "agent", turn: 9 },
		],
	});
	const target = calibrateFoldTarget(state, 10);
	assert.equal(target, FOLD_TARGET_INITIAL + 2 * CALIBRATION_UP_STEP);
	assert.equal(calibrateFoldTarget(state, 10), target, "same-turn re-tick is idempotent");
	assert.equal(state.calibrationEvents.at(-1)?.reason, "correction");

	// Many corrections in one window are capped per turn, and the band clamps.
	const flooded = createAccordionState({
		foldTargetCalibrated: FOLD_TARGET_MAX - 0.01,
		manualChanges: Array.from({ length: 6 }, (_, i) => ({
			blockId: `c${i}`,
			action: "unfold" as const,
			actor: "you" as const,
			turn: 9,
		})),
	});
	assert.equal(calibrateFoldTarget(flooded, 10), FOLD_TARGET_MAX, "clamped at the band ceiling");
});

test("calibrator: quiet pressure decays the target down to the band floor", () => {
	const state = createAccordionState({
		foldTargetCalibrated: FOLD_TARGET_MIN + CALIBRATION_DOWN_STEP * 1.5,
		lastRunHadPressure: true,
		lastRunWithinBudget: true,
	});
	const first = calibrateFoldTarget(state, 20);
	assert.ok(first < FOLD_TARGET_MIN + CALIBRATION_DOWN_STEP * 1.5);
	const second = calibrateFoldTarget(state, 21);
	assert.equal(second, FOLD_TARGET_MIN, "decay clamps at the band floor");
	assert.equal(calibrateFoldTarget(state, 22), FOLD_TARGET_MIN);
	// Without confirmed pressure + headroom, the target holds instead of decaying.
	const idle = createAccordionState();
	assert.equal(calibrateFoldTarget(idle, 5), FOLD_TARGET_INITIAL);
});

test("calibrator: proactive unfolds count as corrections on the next turn", () => {
	const state = createAccordionState({
		recentProactiveUnfoldTurns: [9],
		lastRunHadPressure: true,
		lastRunWithinBudget: true,
	});
	const target = calibrateFoldTarget(state, 10);
	assert.equal(target, FOLD_TARGET_INITIAL + CALIBRATION_UP_STEP);
});

test("calibrator: fixedFoldTarget pins the target and disables ticks", () => {
	const state = createAccordionState({
		manualChanges: [{ blockId: "a", action: "unfold", actor: "you", turn: 9 }],
	});
	assert.equal(calibrateFoldTarget(state, 10, { fixedFoldTarget: 0.7 }), 0.7);
	assert.equal(calibrateFoldTarget(state, 11, { fixedFoldTarget: 0.7 }), 0.7);
	assert.equal(state.foldTargetCalibrated, 0.7);
	// Out-of-band pins clamp into the band rather than escaping it.
	assert.equal(calibrateFoldTarget(state, 12, { fixedFoldTarget: 0.2 }), FOLD_TARGET_MIN);
});

test("conductor run: a correction visibly raises the next run's fold target", () => {
	const messages: AgentMessage[] = [user("u1", "start")];
	for (let i = 0; i < 6; i++) {
		messages.push(assistant(`a${i}`, [txt(bigLines(`drift_chunk${i}`, 60))]));
	}
	messages.push(user("u8", "continue"));
	const state = createAccordionState();
	const first = runConductor({
		messages,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 600,
		state,
		workingTailTokens: 0,
	});
	assert.equal(first.foldTarget, FOLD_TARGET_INITIAL);

	// A human unfolds something after that run (recorded at the tick turn, as the
	// extension does); the next pressure-active turn must open the lens.
	state.manualChanges.push({ blockId: "a0:t0", action: "unfold", actor: "you", turn: 2 });
	const next = [...messages, assistant("a9", [txt(bigLines("fresh", 30))]), user("u10", "continue")];
	const second = runConductor({
		messages: next,
		incomingPrompt: "continue",
		lastCompletedTurn: null,
		budgetTokens: 600,
		state,
		workingTailTokens: 0,
	});
	assert.equal(second.foldTarget, FOLD_TARGET_INITIAL + CALIBRATION_UP_STEP);
	assert.ok(second.assembledTokens <= 600);
});

test("state: levels and calibration survive a serialization round trip", () => {
	const state = createAccordionState({
		foldedBlockIds: ["x", "y", "z"],
		foldLevels: { x: 1, y: 2, z: 3 },
		foldTargetCalibrated: 0.84,
		recentProactiveUnfoldTurns: [4, 6],
		calibrationEvents: [{ turn: 6, from: 0.8, to: 0.84, corrections: 1, reason: "correction" }],
		lastRunHadPressure: true,
		lastRunWithinBudget: true,
	});
	const revived = createAccordionState(JSON.parse(JSON.stringify(state)));
	assert.deepEqual(revived.foldLevels, { x: 1, y: 2, z: 3 });
	assert.equal(revived.foldTargetCalibrated, 0.84);
	assert.deepEqual(revived.recentProactiveUnfoldTurns, [4, 6]);
	assert.equal(revived.calibrationEvents.length, 1);
	assert.equal(revived.lastRunHadPressure, true);
});

test("state: legacy binary folded ids migrate to digest depth", () => {
	const revived = createAccordionState({ foldedBlockIds: ["legacy"] });
	assert.deepEqual(revived.foldLevels, { legacy: 2 });
	// Membership is the source of truth: stale level entries do not resurrect folds.
	const manual = createAccordionState({ foldedBlockIds: [], foldLevels: { stale: 2 } });
	assert.deepEqual(manual.foldLevels, {});
});
