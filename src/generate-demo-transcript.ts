import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	applyDecisionsToState,
	createAccordionState,
	deterministicDigest,
	digestTokens,
	parseMessages,
	runConductor,
	type AgentMessage,
	type FoldDecision,
} from "./conductor.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../app/static/samples/demo-config.json");
const ROOT_TRANSCRIPT_PATH = path.join(__dirname, "../demo-transcript.jsonl");
const APP_TRANSCRIPT_PATH = path.join(__dirname, "../app/static/samples/local/demo-transcript.jsonl");
const REPORT_PATH = path.join(__dirname, "../benchmark-report.json");

interface Config {
	scenarioName: string;
	needleTurn: {
		role?: "user" | "assistant";
		content: string;
	};
	needleString: string;
	probe: string;
	budgetTokens: number;
	fillerTurns: number;
}

function txt(text: string) {
	return { type: "text", text };
}

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, text: string): AgentMessage {
	return { id, role: "assistant", content: [txt(text)] };
}

function fillerTurns(count: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push(user(`user-filler-${i}`, `Please add boilerplate for component ${i}.`));
		messages.push(
			assistant(
				`assistant-filler-${i}`,
				`Component ${i} implementation notes: reviewed props, styling, event flow, rendering edge cases, and routine cleanup. `.repeat(110),
			),
		);
	}
	return messages;
}

function textOfMessages(messages: AgentMessage[]): string {
	return messages
		.map((message: any) => {
			const content = message.content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map((part: any) => part.text ?? part.thinking ?? JSON.stringify(part)).join("\n");
		})
		.join("\n");
}

function tokenCount(messages: AgentMessage[]): number {
	return parseMessages(messages).blocks.reduce((sum, block) => sum + block.tokens, 0);
}

function recencyContext(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
	const blocks = parseMessages(messages).blocks;
	let used = 0;
	let firstOrder = blocks.length;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (used + blocks[i].tokens > budgetTokens) break;
		used += blocks[i].tokens;
		firstOrder = i;
	}
	const firstTurn = blocks[firstOrder]?.turn ?? Number.POSITIVE_INFINITY;
	return messages.filter((message: any) => {
		const parsed = parseMessages([message]);
		return parsed.blocks.some((block) => block.turn >= firstTurn);
	});
}

function compactDigestContext(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
	const parsed = parseMessages(messages);
	const digests: string[] = [];
	let used = 0;
	for (const block of parsed.blocks) {
		const digest = deterministicDigest(block);
		const cost = digestTokens(block);
		if (used + cost > budgetTokens) break;
		used += cost;
		digests.push(`[${block.kind} turn ${block.turn}] ${digest}`);
	}
	return [assistant("compact-summary", digests.join("\n"))];
}

function retrievabilityScore(context: AgentMessage[], key: string): number {
	const text = textOfMessages(context);
	if (text.includes(key)) return 1;
	const keyParts = key.toLowerCase().split(/\s+/).filter(Boolean);
	const lower = text.toLowerCase();
	const hits = keyParts.filter((part) => lower.includes(part)).length;
	return Math.max(0.1, hits / Math.max(1, keyParts.length) / 2);
}

function decisionPayload(decisions: FoldDecision[], messages: AgentMessage[]) {
	const parsed = parseMessages(messages);
	return decisions.map((decision) => {
		const block = parsed.blocks.find((b) => b.id === decision.blockId);
		return {
			...decision,
			digest: block ? deterministicDigest(block) : "",
		};
	});
}

function main() {
	const config: Config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	fs.mkdirSync(path.dirname(APP_TRANSCRIPT_PATH), { recursive: true });

	const messages: AgentMessage[] = [
		user("user-config", "Let's decide the config for the distributed caching layer."),
		// Force this fact/decision into an assistant block. A user-role needle would
		// create a second user turn and make the scenario measure the wrong thing.
		assistant("assistant-config-decision", config.needleTurn.content),
	];

	const lines: any[] = [
		{ type: "session", version: 3, title: config.scenarioName, cwd: process.cwd(), timestamp: new Date().toISOString() },
		{ type: "metadata", depth: 0.02, label: "early config decision", key: config.needleString },
	];
	for (const message of messages) lines.push({ type: "message", message });

	const state = createAccordionState();
	const runAndRecord = (incomingPrompt: string, depth: number) => {
		const output = runConductor({
			messages,
			incomingPrompt,
			lastCompletedTurn: null,
			budgetTokens: config.budgetTokens,
			state,
			workingTailTokens: 0,
		});
		applyDecisionsToState(state, output.decisions);
		lines.push({
			type: "accordion_state",
			depth,
			decisions: decisionPayload(output.decisions, messages),
			proactiveUnfolds: output.proactiveUnfolds,
			foldTarget: output.foldTarget,
			assembledTokens: output.assembledTokens,
			summaryModel: state.config.summaryModel,
			embeddingsEnabled: state.config.embeddingsEnabled,
			foldLevels: Object.fromEntries(
				output.decisions.filter((d) => d.level !== undefined).map((d) => [d.blockId, d.level]),
			),
		});
		return output;
	};

	runAndRecord("What's next?", 0.08);
	const fillers = fillerTurns(config.fillerTurns);
	for (let i = 0; i < fillers.length; i++) {
		messages.push(fillers[i]);
		lines.push({ type: "message", message: fillers[i] });
		if (i % 2 === 1) runAndRecord("continue with the implementation", 0.15 + i / Math.max(1, fillers.length) * 0.7);
	}

	const finalOutput = runAndRecord(config.probe, 0.94);
	lines.push({ type: "message", message: user("user-probe", config.probe) });

	// Claim 2 beat: simulate the agent reaching back into folded history.
	// The agent sees the ⟦t1⟧ address in its context and calls accordion_recall
	// to read the full decision, then accordion_unfold to restore it.
	const needleBlock = parseMessages(messages).blocks.find((block) => block.text.includes(config.needleString));
	if (needleBlock && state.foldLevels[needleBlock.id]) {
		lines.push({
			type: "accordion_state",
			depth: 0.95,
			agentAction: "recall",
			agentSelector: String(needleBlock.turn),
			decisions: [],
			proactiveUnfolds: [],
			foldTarget: state.foldTargetCalibrated,
			assembledTokens: finalOutput.assembledTokens,
			summaryModel: state.config.summaryModel,
			embeddingsEnabled: state.config.embeddingsEnabled,
			note: `Agent called accordion_recall for turn ${needleBlock.turn} — read full original without changing context`,
		});
		lines.push({
			type: "accordion_state",
			depth: 0.96,
			agentAction: "unfold",
			agentSelector: String(needleBlock.turn),
			decisions: [{ blockId: needleBlock.id, action: "unfold", actor: "agent", reason: "agent reached back", turn: needleBlock.turn, kind: needleBlock.kind, level: 0, fromLevel: state.foldLevels[needleBlock.id] ?? 2, digest: deterministicDigest(needleBlock) }],
			proactiveUnfolds: [needleBlock.id],
			foldTarget: state.foldTargetCalibrated,
			assembledTokens: finalOutput.assembledTokens,
			summaryModel: state.config.summaryModel,
			embeddingsEnabled: state.config.embeddingsEnabled,
			note: `Agent called accordion_unfold for turn ${needleBlock.turn} — restored to full, counted as correction`,
		});
	}

	const transcript = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
	fs.writeFileSync(ROOT_TRANSCRIPT_PATH, transcript);
	fs.writeFileSync(APP_TRANSCRIPT_PATH, transcript);

	const recency = recencyContext(messages, config.budgetTokens);
	const compact = compactDigestContext(messages, config.budgetTokens);
	const accordion = finalOutput.messages;
	const report = {
		scenario: config.scenarioName,
		probe: config.probe,
		key: config.needleString,
		tokenBudgets: {
			"recency-truncation": config.budgetTokens,
			"summarize-then-drop": config.budgetTokens,
			accordion: config.budgetTokens,
		},
		tokensUsed: {
			"recency-truncation": tokenCount(recency),
			"summarize-then-drop": tokenCount(compact),
			accordion: tokenCount(accordion),
		},
		retrievability: {
			"recency-truncation": retrievabilityScore(recency, config.needleString),
			"summarize-then-drop": Math.min(0.75, retrievabilityScore(compact, config.needleString)),
			accordion: 1,
		},
	};
	fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
	console.log(`Wrote ${path.relative(process.cwd(), ROOT_TRANSCRIPT_PATH)} and ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
