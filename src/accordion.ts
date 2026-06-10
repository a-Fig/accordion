/**
 * Accordion Context Extension
 * ===========================
 * Rewrites the outgoing pi context with the Accordion Conductor. Originals stay
 * in the session log; the Conductor only changes the assembled view sent to the
 * model for this call.
 */

import { writeFile } from "node:fs";
import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AGENT_TOOL_DEFS, agentFold, agentRecall, agentUnfold } from "./agent-tools.ts";
import { ACCORDION_AGENT_SKILL } from "./accordion-skill.ts";
import {
	applyDecisionsToState,
	createAccordionState,
	createGeminiSummaryProvider,
	createHaikuSummaryProvider,
	createOllamaSummaryProvider,
	createTransformersEmbeddingProvider,
	defaultConductorConfig,
	mergeConductorConfig,
	pruneEmbeddingCache,
	warmEmbeddings,
	blockTokensAtLevel,
	extractIncomingPrompt,
	lastCompletedTurnFromMessages,
	parseMessages,
	runConductor,
	type AccordionState,
	type ConductorConfig,
	type ContextBlock,
	type FoldDecision,
	type SummaryProvider,
} from "./conductor.ts";

const LIVE_SNAPSHOT_PATH = `${homedir()}/.pi/agent/accordion-live-session.jsonl`;

const LEGACY_STATE_TYPE = "accordion-state";
const CONDUCTOR_STATE_TYPE = "accordion-conductor-state";
const CONDUCTOR_DECISION_TYPE = "accordion-conductor-decision";

const IS_NODE_TEST = process.env.NODE_TEST_CONTEXT === "child-v8";
const ENV_EMBEDDINGS_ENABLED = process.env.ACCORDION_EMBEDDINGS === "1" || process.env.ACCORDION_EMBEDDINGS === "true";
const ENV_SUMMARIES_ENABLED =
	process.env.ACCORDION_SUMMARIES === "1" ||
	process.env.ACCORDION_SUMMARIES === "true" ||
	(!IS_NODE_TEST && process.env.ACCORDION_SUMMARIES !== "0");

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
};

function effectiveSummariesEnabled(config: ConductorConfig): boolean {
	return config.summariesEnabled && ENV_SUMMARIES_ENABLED;
}

function effectiveEmbeddingsEnabled(config: ConductorConfig): boolean {
	return config.embeddingsEnabled || ENV_EMBEDDINGS_ENABLED;
}

function buildSummaryProvider(config: ConductorConfig): SummaryProvider | undefined {
	if (!effectiveSummariesEnabled(config)) return undefined;
	if (process.env.ACCORDION_OLLAMA === "1" || process.env.ACCORDION_OLLAMA === "true") {
		return createOllamaSummaryProvider({
			baseUrl: config.ollamaBaseUrl,
			model: config.ollamaModel,
			timeoutMs: config.summaryTimeoutMs,
		});
	}
	return createHaikuSummaryProvider(process.env.ANTHROPIC_API_KEY, config.summaryModel) ?? createGeminiSummaryProvider(process.env.GOOGLE_API_KEY);
}

let state: AccordionState = createAccordionState();
let lastKnownMessages: AgentMessage[] = [];
let summaryProvider = buildSummaryProvider(state.config);
let embeddingProvider: any = null;
let embeddingProviderInitAttempted = false;
let lastEmbeddingModel = state.config.embeddingModel;

function writeLiveSnapshot(ctx: ExtensionContext): void {
	try {
		const branch = ctx.sessionManager.getBranch() as any[];
		const relevant = branch.filter((e: any) => e.type === "session" || e.type === "message" || e.type === "compaction");
		if (!relevant.some((e: any) => e.type === "session")) {
			relevant.unshift({ type: "session", version: 3, cwd: "", timestamp: new Date().toISOString() });
		}
		relevant.push({
			type: "custom",
			customType: CONDUCTOR_STATE_TYPE,
			data: { foldTargetCalibrated: state.foldTargetCalibrated, config: state.config },
		});
		const lines = relevant.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
		writeFile(LIVE_SNAPSHOT_PATH, lines, "utf8", () => {});
	} catch {}
}

function resetProviders(): void {
	summaryProvider = buildSummaryProvider(state.config);
	embeddingProvider = null;
	embeddingProviderInitAttempted = false;
	lastEmbeddingModel = state.config.embeddingModel;
}

function restoreState(ctx: ExtensionContext): void {
	state = createAccordionState();
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "custom" || !entry.data) continue;
		if (entry.customType === CONDUCTOR_STATE_TYPE) {
			state = createAccordionState(entry.data);
		} else if (entry.customType === LEGACY_STATE_TYPE && Array.isArray(entry.data.expanded)) {
			state.pinnedTurnIndexes = entry.data.expanded;
		}
	}
	resetProviders();
}

async function ensureEmbeddingProvider(config: ConductorConfig): Promise<void> {
	if (!effectiveEmbeddingsEnabled(config)) return;
	if (embeddingProvider && lastEmbeddingModel === config.embeddingModel) return;
	embeddingProviderInitAttempted = true;
	lastEmbeddingModel = config.embeddingModel;
	try {
		embeddingProvider = await createTransformersEmbeddingProvider(config.embeddingModel);
	} catch (error: any) {
		embeddingProvider = null;
		throw error;
	}
}

function persist(pi: ExtensionAPI, blocks: ContextBlock[] = [], incomingPrompt = ""): void {
	pruneEmbeddingCache(state, blocks, incomingPrompt);
	pi.appendEntry(CONDUCTOR_STATE_TYPE, {
		foldedBlockIds: state.foldedBlockIds,
		pinnedBlockIds: state.pinnedBlockIds,
		pinnedTurnIndexes: state.pinnedTurnIndexes,
		summaryCache: state.summaryCache,
		pendingSummaryHashes: state.pendingSummaryHashes,
		manualChanges: state.manualChanges,
		missingApiKeyLogged: state.missingApiKeyLogged,
		embeddingCache: state.embeddingCache,
		foldLevels: state.foldLevels,
		foldTargetCalibrated: state.foldTargetCalibrated,
		lastCalibrationTurn: state.lastCalibrationTurn,
		recentProactiveUnfoldTurns: state.recentProactiveUnfoldTurns,
		lastRunHadPressure: state.lastRunHadPressure,
		lastRunWithinBudget: state.lastRunWithinBudget,
		calibrationEvents: state.calibrationEvents,
		config: state.config,
	});
}

function persistDecisions(pi: ExtensionAPI, decisions: FoldDecision[]): void {
	for (const decision of decisions) {
		pi.appendEntry(CONDUCTOR_DECISION_TYPE, decision);
	}
}

function liveMessages(ctx: ExtensionContext): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type === "message") out.push(entry.message);
	}
	lastKnownMessages = out;
	return out;
}

function turnTitle(messages: AgentMessage[], turn: number): string {
	const block = parseMessages(messages).blocks.find((b) => b.turn === turn && b.kind === "user");
	const first = (block?.text ?? "").split("\n")[0] ?? "";
	return truncate(first, 56);
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n - 3).trimEnd() + "...";
}

function turnState(blockIds: string[], turn: number): string {
	const folded = new Set(state.foldedBlockIds);
	const pinned = new Set(state.pinnedBlockIds);
	if (state.pinnedTurnIndexes.includes(turn) || blockIds.some((id) => pinned.has(id))) return "PINNED";
	const foldedCount = blockIds.filter((id) => folded.has(id)).length;
	if (foldedCount === 0) return "FULL";
	if (foldedCount === blockIds.length) return "folded";
	return "MIXED";
}

function currentTurnCount(ctx: ExtensionCommandContext): number {
	return parseMessages(liveMessages(ctx)).turns.length;
}

function pinTurn(turn: number, ctx: ExtensionCommandContext): boolean {
	const parsed = parseMessages(liveMessages(ctx));
	if (!parsed.turns.some((t) => t.index === turn)) return false;
	if (!state.pinnedTurnIndexes.includes(turn)) state.pinnedTurnIndexes.push(turn);
	const folded = new Set(state.foldedBlockIds);
	const currentTurn = parsed.turns.at(-1)?.index ?? turn;
	for (const block of parsed.blocks) {
		if (block.turn !== turn) continue;
		folded.delete(block.id);
		delete state.foldLevels[block.id];
		state.manualChanges.push({ blockId: block.id, action: "unfold", actor: "you", turn: currentTurn });
	}
	state.foldedBlockIds = [...folded];
	state.manualChanges = state.manualChanges.slice(-200);
	return true;
}

function unpinTurn(turn: number, ctx: ExtensionCommandContext): boolean {
	const before = state.pinnedTurnIndexes.length + state.pinnedBlockIds.length;
	state.pinnedTurnIndexes = state.pinnedTurnIndexes.filter((n) => n !== turn);
	const parsed = parseMessages(liveMessages(ctx));
	const turnBlockIds = new Set(parsed.blocks.filter((b) => b.turn === turn).map((b) => b.id));
	state.pinnedBlockIds = state.pinnedBlockIds.filter((id) => !turnBlockIds.has(id));
	return state.pinnedTurnIndexes.length + state.pinnedBlockIds.length !== before;
}

export default function accordionExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion"));
		writeLiveSnapshot(ctx);
	});

	pi.on("context", async (event, ctx) => {
		const before = JSON.stringify(state);
		const incomingPrompt = extractIncomingPrompt(event.messages);
		const parsed = parseMessages(event.messages);

		try {
			await ensureEmbeddingProvider(state.config);
		} catch (error: any) {
			ctx.ui.notify(error.message, "warning");
		}

		if (effectiveEmbeddingsEnabled(state.config) && embeddingProvider) {
			try {
				await warmEmbeddings(parsed.blocks, incomingPrompt, embeddingProvider, state);
			} catch (error: any) {
				ctx.ui.notify(error.message || "Failed to warm embeddings", "warning");
			}
		}

		const output = runConductor(
			{
				messages: event.messages,
				incomingPrompt,
				lastCompletedTurn: lastCompletedTurnFromMessages(liveMessages(ctx)),
				budgetTokens: state.config.budgetTokens,
				workingTailTokens: state.config.workingTailTokens,
				state,
			},
			{
				summaryProvider,
				embeddingProvider,
				onSummary: () => persist(pi, parsed.blocks, incomingPrompt),
				log: (message) => ctx.ui.notify(message, "info"),
			},
		);

		if (output.decisions.length) {
			applyDecisionsToState(state, output.decisions);
			persistDecisions(pi, output.decisions);
		}
		for (const warning of output.warnings) ctx.ui.notify(warning, "warning");
		if (before !== JSON.stringify(state)) persist(pi, parsed.blocks, incomingPrompt);
		writeLiveSnapshot(ctx);

		// Inject skill when any blocks are folded so the model knows how to reach back.
		let finalMessages = output.messages;
		if (state.foldedBlockIds.length > 0) {
			if (finalMessages === (event.messages as any)) {
				finalMessages = (event.messages as any[]).map((m: any) => ({
					...m,
					content: Array.isArray(m.content) ? m.content.map((c: any) => ({ ...c })) : m.content,
				}));
			}
			const foldedIds = new Set(state.foldedBlockIds);
			const foldedTurns = [...new Set(
				parsed.blocks.filter((b) => foldedIds.has(b.id)).map((b) => b.turn),
			)].sort((a, b) => a - b);
			const appendix = `Currently folded: turns ${formatTurnList(foldedTurns)}. Conductor target: ${Math.round(output.foldTarget * 100)}%.`;
			const skillText = `${ACCORDION_AGENT_SKILL}\n\n${appendix}`;
			for (const msg of finalMessages) {
				if ((msg as any).role === "assistant" && Array.isArray((msg as any).content)) {
					(msg as any).content.unshift({ type: "text", text: skillText });
					break;
				}
			}
		}

		if (output.decisions.length || finalMessages !== (event.messages as any)) return { messages: finalMessages };
	});

	pi.on("session_before_compact", (_event, ctx) => {
		const messages = liveMessages(ctx);
		const parsed = parseMessages(messages);
		const incomingPrompt = extractIncomingPrompt(messages);
		const beforeCount = state.foldedBlockIds.length;

		const output = runConductor(
			{
				messages,
				incomingPrompt,
				lastCompletedTurn: lastCompletedTurnFromMessages(messages),
				budgetTokens: state.config.budgetTokens,
				workingTailTokens: state.config.workingTailTokens,
				state,
			},
			{
				summaryProvider,
				log: (msg) => ctx.ui.notify(msg, "info"),
			},
		);

		if (output.decisions.length) {
			applyDecisionsToState(state, output.decisions);
			persistDecisions(pi, output.decisions);
		}
		persist(pi, parsed.blocks, incomingPrompt);

		const folded = new Set(state.foldedBlockIds);
		const liveTok = parsed.blocks.reduce((sum, b) => sum + (folded.has(b.id) ? blockTokensAtLevel(b, state.foldLevels[b.id] ?? 2) : b.tokens), 0);
		const newFolds = state.foldedBlockIds.length - beforeCount;
		ctx.ui.notify(
			`Accordion: ${state.foldedBlockIds.length} blocks folded${newFolds > 0 ? ` (+${newFolds} new)` : ""} · live ~${liveTok.toLocaleString()} tok`,
			"info",
		);

		writeLiveSnapshot(ctx);
		return { cancel: true };
	});

	pi.registerCommand("accordion", {
		description: "Trigger Accordion context folding (like /compact); use /accordion status for a turn-by-turn report",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (args.trim() === "status") {
				const messages = liveMessages(ctx);
				const parsed = parseMessages(messages);
				const folded = new Set(state.foldedBlockIds);
				const fullTok = parsed.blocks.reduce((sum, block) => sum + block.tokens, 0);
				const liveTok = parsed.blocks.reduce((sum, block) => sum + (folded.has(block.id) ? blockTokensAtLevel(block, state.foldLevels[block.id] ?? 2) : block.tokens), 0);
				const lines = [
					`Accordion Conductor - ${parsed.turns.length} turns | budget=${state.config.budgetTokens.toLocaleString()} tok`,
					`live ~${liveTok.toLocaleString()} tok | full ~${fullTok.toLocaleString()} tok | pinned turns: [${state.pinnedTurnIndexes.sort((a, b) => a - b).join(",") || "none"}]`,
					...parsed.turns.map((turn) => {
						const ids = parsed.blocks.filter((b) => b.turn === turn.index).map((b) => b.id);
						const tok = parsed.blocks.filter((b) => b.turn === turn.index).reduce((sum, b) => sum + b.tokens, 0);
						return `  #${String(turn.index).padStart(3)}  ${turnState(ids, turn.index).padEnd(8)} ~${String(tok).padStart(6)} tok  ${turnTitle(messages, turn.index)}`;
					}),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			ctx.compact();
		},
	});

	pi.registerCommand("expand", {
		description: "Pin a turn open so the Conductor will not fold it: /expand <turn#>",
		getArgumentCompletions: (prefix: string) => {
			const n = prefix.trim();
			const out = [];
			for (let i = 1; i <= 999; i++) {
				if (!String(i).startsWith(n)) continue;
				if (state.pinnedTurnIndexes.includes(i)) continue;
				out.push({ value: String(i), label: `turn ${i}` });
				if (out.length >= 20) break;
			}
			return out;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const n = parseInt(args.trim(), 10);
			if (!Number.isFinite(n) || n < 1 || n > currentTurnCount(ctx) || !pinTurn(n, ctx)) {
				ctx.ui.notify("Usage: /expand <turn#>  (see /accordion for numbers)", "warning");
				return;
			}
			persist(pi, parseMessages(liveMessages(ctx)).blocks);
			writeLiveSnapshot(ctx);
			ctx.ui.notify(`Turn ${n} pinned open - shown in full on the next message.`, "info");
		},
	});

	pi.registerCommand("collapse", {
		description: "Unpin a previously expanded turn: /collapse <turn#>",
		getArgumentCompletions: (prefix: string) => {
			const n = prefix.trim();
			return state.pinnedTurnIndexes
				.sort((a, b) => a - b)
				.filter((i) => String(i).startsWith(n))
				.map((i) => ({ value: String(i), label: `turn ${i}` }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const n = parseInt(args.trim(), 10);
			if (!Number.isFinite(n) || !unpinTurn(n, ctx)) {
				ctx.ui.notify("Usage: /collapse <turn#>  (must be a currently-expanded turn)", "warning");
				return;
			}
			persist(pi, parseMessages(liveMessages(ctx)).blocks);
			writeLiveSnapshot(ctx);
			ctx.ui.notify(`Turn ${n} unpinned - the Conductor may fold it on the next message.`, "info");
		},
	});

	pi.registerCommand("fold", {
		description: "Fold a turn to digests right now: /fold <turn#> (reversible; /expand or /peek to get it back)",
		getArgumentCompletions: turnCompletions,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = agentFold(liveMessages(ctx), state, args.trim());
			// Human-invoked: re-attribute the change records to "you".
			for (const change of result.changes) change.actor = "you";
			for (let i = state.manualChanges.length - result.changes.length; i < state.manualChanges.length; i++) {
				if (i >= 0) state.manualChanges[i].actor = "you";
			}
			if (!result.ok) {
				ctx.ui.notify(`Usage: /fold <turn#>  \u2014 ${result.message}`, "warning");
				return;
			}
			if (result.changes.length) persistDecisions(pi, result.changes);
			persist(pi, parseMessages(liveMessages(ctx)).blocks);
			writeLiveSnapshot(ctx);
			ctx.ui.notify(result.message, "info");
		},
	});

	pi.registerCommand("peek", {
		description: "Read a folded turn in full without changing the agent's context: /peek <turn#>",
		getArgumentCompletions: turnCompletions,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = agentRecall(liveMessages(ctx), state, args.trim(), 4_000);
			if (!result.ok) {
				ctx.ui.notify(`Usage: /peek <turn#>  \u2014 ${result.message}`, "warning");
				return;
			}
			ctx.ui.notify(result.content, "info");
		},
	});

	pi.registerCommand("conductor-config", {
		description: "Show or update Conductor runtime config (debug): /conductor-config [json]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify(JSON.stringify(state.config, null, 2), "info");
				return;
			}
			try {
				const patch = JSON.parse(raw) as Partial<ConductorConfig>;
				state.config = mergeConductorConfig({ ...state.config, ...patch });
				resetProviders();
				persist(pi);
				ctx.ui.notify("Conductor config updated — takes effect on the next message.", "info");
			} catch (error) {
				ctx.ui.notify(`Invalid config JSON: ${String(error)}`, "warning");
			}
		},
	});

	registerAgentTools(pi);
}

function formatTurnList(turns: number[]): string {
	if (turns.length === 0) return "none";
	const sorted = [...turns].sort((a, b) => a - b);
	const ranges: string[] = [];
	let start = sorted[0], prev = sorted[0];
	for (let i = 1; i <= sorted.length; i++) {
		const t = sorted[i];
		if (t === prev + 1) { prev = t; continue; }
		ranges.push(start === prev ? String(start) : `${start}–${prev}`);
		start = prev = t;
	}
	return ranges.join(", ");
}

function turnCompletions(prefix: string): Array<{ value: string; label: string }> {
	const n = prefix.trim();
	const out: Array<{ value: string; label: string }> = [];
	for (let i = 1; i <= 999; i++) {
		if (!String(i).startsWith(n)) continue;
		out.push({ value: String(i), label: `turn ${i}` });
		if (out.length >= 20) break;
	}
	return out;
}

function textToolResult(text: string): TextToolResult {
	return { content: [{ type: "text", text }], details: {} };
}

/**
 * Bidirectional memory: register model-callable tools when the host pi build
 * supports extension tools. Feature-detected so the extension stays compatible
 * with older pi versions (where /peek, /fold, /expand cover the human side).
 */
export function registerAgentTools(pi: ExtensionAPI): void {
	const register = (pi as any).registerTool;
	if (typeof register !== "function") return;

	// Tool handlers may run without a command context in some hosts; cache the
	// latest branch ctx from event handlers as a fallback message source.
	const messagesFrom = (ctx: any): AgentMessage[] => {
		try {
			if (ctx?.sessionManager?.getBranch) return liveMessages(ctx);
		} catch {}
		return lastKnownMessages;
	};
	// Tolerate (args, ctx), (toolCallId, args, ctx), or ({turns}, ctx) signatures.
	const pickArgs = (xs: any[]) => xs.find((x) => x && typeof x === "object" && "turns" in x) ?? {};
	const pickCtx = (xs: any[]) => xs.find((x) => x && typeof x === "object" && x.sessionManager) ?? null;

	const wire = (
		def: (typeof AGENT_TOOL_DEFS)[number],
		run: (messages: AgentMessage[], turns: string, ctx: any) => string,
	) => {
		try {
			register.call(pi, {
				...def,
				label: def.name.replace("accordion_", "accordion "),
				execute: async (...xs: any[]) => {
					const args = pickArgs(xs);
					const ctx = pickCtx(xs);
					const messages = messagesFrom(ctx);
					if (messages.length === 0) return textToolResult("Accordion: no session messages available yet.");
					try {
						return textToolResult(run(messages, String(args.turns ?? ""), ctx));
					} catch (error) {
						return textToolResult(`Accordion tool error: ${String(error)}`);
					}
				},
			});
		} catch {}
	};

	wire(AGENT_TOOL_DEFS[0], (messages, turns) => {
		const result = agentRecall(messages, state, turns);
		return result.ok ? `${result.content}\n\n${result.message}` : result.message;
	});
	wire(AGENT_TOOL_DEFS[1], (messages, turns, ctx) => {
		const result = agentUnfold(messages, state, turns);
		if (result.changes.length) {
			persistDecisions(pi, result.changes);
			persist(pi, parseMessages(messages).blocks);
			if (ctx) writeLiveSnapshot(ctx);
		}
		return result.message;
	});
	wire(AGENT_TOOL_DEFS[2], (messages, turns, ctx) => {
		const result = agentFold(messages, state, turns);
		if (result.changes.length) {
			persistDecisions(pi, result.changes);
			persist(pi, parseMessages(messages).blocks);
			if (ctx) writeLiveSnapshot(ctx);
		}
		return result.message;
	});
}
