import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConductorModelAuthority } from "./conductor-model-authority.ts";
import {
	createAccordionState,
	createArtifactConductorModelProviders,
	createLocalConductorModelProviders,
	createTransformersEmbeddingProvider,
	estTokens,
	parseMessages,
	parseConductorModelArtifact,
	runConductor,
	warmEmbeddings,
	warmConductorModel,
	type AgentMessage,
	type ConductorDependencies,
	type ConductorModelAuthority,
	type ConductorModelArtifact,
	type ContextBlock,
	type EmbeddingProvider,
} from "./conductor.ts";

interface Scenario {
	name: string;
	category: "exact" | "semantic";
	key: string;
	aliases?: string[];
	forbiddenAnswerTerms?: string[];
	probe: string;
	messages: AgentMessage[];
}

interface StrategyResult {
	tokens: number;
	withinBudget: boolean;
	hasKey: boolean;
	answer?: string;
	score?: number;
}

interface ComparisonCell {
	scenario: string;
	budget: number;
	recency: StrategyResult;
	compact: StrategyResult;
	accordion: StrategyResult;
}

interface ProofSummary {
	cells: number;
	accordionScore: number;
	compactScore: number;
	accordionWinsVsCompact: number;
	compactWinsVsAccordion: number;
	tiesVsCompact: number;
	accordionBudgetViolations: number;
	compactBudgetViolations: number;
	accordionAdvantagePoints: number;
	representativeWins: Array<{
		scenario: string;
		budget: number;
		compactTokens: number;
		accordionTokens: number;
		compactAnswer?: string;
		accordionAnswer?: string;
	}>;
}

type CompactMode = "deterministic" | "external" | "llm";

interface ExternalCompactFixture {
	scenario: string;
	budget: number;
	summary: string;
	captureProtocol?: string;
	finalPrompt?: string;
	probe?: string;
	key?: string;
	aliases?: string[];
	forbiddenAnswerTerms?: string[];
	setupTranscript?: Array<{ role: string; text: string }>;
	transcript?: Array<{ role: string; text: string }>;
}

const DEFAULT_BUDGETS = [1_500, 2_500, 4_000];
const DEFAULT_OUT = "docs/compact-comparison.json";
const SYSTEM_PROMPT =
	"Answer using only the conversation context. If the exact requested value is present, quote it exactly. Be brief.";
const COMPACT_SYSTEM_PROMPT =
	"You are compacting an agent conversation for future work. Preserve durable decisions, exact file paths, exact marker values, errors, and outcomes when possible. Be concise.";

function txt(text: string) {
	return { type: "text", text };
}

function user(id: string, text: string): AgentMessage {
	return { id, role: "user", content: [txt(text)] };
}

function assistant(id: string, text: string): AgentMessage {
	return { id, role: "assistant", content: [txt(text)] };
}

function fillerText(seed: string, repeats: number): string {
	return Array.from({ length: repeats }, (_, i) =>
		`${seed} implementation note ${i}: reviewed component wiring, event flow, styling edge cases, and routine cleanup.`,
	).join(" ");
}

export function buildScenarios(): Scenario[] {
	const scenarios: Scenario[] = [];

	scenarios.push({
		name: "distributed-cache-decision",
		category: "exact",
		key: "standardize on Redis",
		probe: "What did we decide for the distributed caching layer and future pub/sub requirements?",
		messages: [
			user("u-cache", "Let's decide on the cache architecture."),
			assistant(
				"a-cache",
				"We evaluated Memcached, Hazelcast, local in-memory caches, and Redis. The final decision was to standardize on Redis for the distributed caching layer on port 6379 because future pub/sub requirements matter.",
			),
			...fillerTurns("cache-filler", 12, 85),
			user("u-probe-cache", "What did we decide for the distributed caching layer and future pub/sub requirements?"),
		],
	});

	scenarios.push({
		name: "release-marker",
		category: "exact",
		key: "MANGO-WHISPER-9",
		probe: "What exact release marker did we record for the rollback rehearsal?",
		messages: [
			user("u-rollback", "Record the release rehearsal values."),
			assistant(
				"a-rollback",
				"The rollback rehearsal release marker is MANGO-WHISPER-9. Store it exactly; similar looking marker values are decoys.",
			),
			...fillerTurns("ops-filler", 16, 70),
			user("u-probe-rollback", "What exact release marker did we record for the rollback rehearsal?"),
		],
	});

	scenarios.push({
		name: "file-and-error",
		category: "exact",
		key: "src/lib/engine/digest.ts",
		probe: "Which file had the digest normalization bug?",
		messages: [
			user("u-error", "Track the digest normalization bug."),
			assistant(
				"a-error",
				"The digest normalization bug was isolated to src/lib/engine/digest.ts. The symptom was duplicated whitespace causing unstable previews.",
			),
			...fillerTurns("ui-filler", 14, 80),
			user("u-probe-error", "Which file had the digest normalization bug?"),
		],
	});

	scenarios.push({
		name: "crowded-file-list",
		category: "exact",
		key: "src/routes/admin/export.ts",
		forbiddenAnswerTerms: ["src/lib/auth.ts", "src/lib/cache.ts", "src/lib/db.ts", "src/routes/login.ts", "src/routes/settings.ts"],
		probe: "Which exact file owns the admin CSV export timeout bug?",
		messages: [
			user("u-crowded-file", "Capture the admin export investigation result."),
			assistant(
				"a-crowded-file",
				[
					"We checked src/lib/auth.ts, src/lib/cache.ts, src/lib/db.ts, src/routes/login.ts, and src/routes/settings.ts first.",
					"The actual admin CSV export timeout bug belongs to src/routes/admin/export.ts because the streaming cursor never closes.",
				].join(" "),
			),
			...fillerTurns("admin-filler", 15, 75),
			user("u-probe-crowded-file", "Which exact file owns the admin CSV export timeout bug?"),
		],
	});

	scenarios.push({
		name: "late-natural-language-decision",
		category: "exact",
		key: "queue writes until reconnect",
		probe: "What did we decide the offline editor should do with writes while disconnected?",
		messages: [
			user("u-offline", "Decide the offline editor behavior."),
			assistant(
				"a-offline",
				[
					"We discussed optimistic updates, conflict dialogs, server-side merge functions, retry timers, and draft banners.",
					"Most of the meeting focused on naming, telemetry, and how to keep the sync status visible without distracting the user.",
					"The final product decision was to queue writes until reconnect, then replay them in original order after a fresh server version check.",
				].join(" "),
			),
			...fillerTurns("offline-filler", 13, 82),
			user("u-probe-offline", "What did we decide the offline editor should do with writes while disconnected?"),
		],
	});

	scenarios.push({
		name: "api-endpoint-choice",
		category: "exact",
		key: "POST /v2/rsvps/import",
		forbiddenAnswerTerms: ["GET /v1/rsvps/import", "POST /v1/admin/rsvps"],
		probe: "Which endpoint did we choose for the RSVP import flow?",
		messages: [
			user("u-api", "Capture the RSVP import endpoint decision."),
			assistant(
				"a-api",
				[
					"We rejected GET /v1/rsvps/import because imports are not idempotent.",
					"We also rejected POST /v1/admin/rsvps because the route already carries manual edits.",
					"The selected endpoint for the RSVP import flow is POST /v2/rsvps/import.",
				].join(" "),
			),
			...fillerTurns("api-filler", 12, 88),
			user("u-probe-api", "Which endpoint did we choose for the RSVP import flow?"),
		],
	});

	scenarios.push({
		name: "crowded-endpoint-list",
		category: "exact",
		key: "POST /v3/admin/bulk-invites",
		forbiddenAnswerTerms: ["GET /v1/invites", "POST /v1/admin/invites", "PATCH /v2/invites/bulk", "POST /v2/admin/uploads"],
		probe: "Which API route handles the bulk invite import?",
		messages: [
			user("u-crowded-endpoint", "Capture the bulk invite import route."),
			assistant(
				"a-crowded-endpoint",
				[
					"We ruled out GET /v1/invites because imports mutate state.",
					"We also ruled out POST /v1/admin/invites because it only handles one invite at a time.",
					"PATCH /v2/invites/bulk remains reserved for status changes, and POST /v2/admin/uploads is only for raw file storage.",
					"Bulk invite imports use POST /v3/admin/bulk-invites after CSV validation and duplicate detection.",
				].join(" "),
			),
			...fillerTurns("endpoint-filler", 12, 88),
			user("u-probe-crowded-endpoint", "Which API route handles the bulk invite import?"),
		],
	});

	scenarios.push({
		name: "ui-policy-choice",
		category: "exact",
		key: "show the confidence badge only after three matching sources",
		aliases: ["after three matching sources", "three matching sources"],
		probe: "When should the research UI show the confidence badge?",
		messages: [
			user("u-policy", "Settle the research confidence badge rule."),
			assistant(
				"a-policy",
				[
					"We considered showing confidence immediately, hiding it entirely, and making it a manual reviewer field.",
					"The selected UI policy is to show the confidence badge only after three matching sources, because one source created false certainty in testing.",
				].join(" "),
			),
			...fillerTurns("policy-filler", 15, 72),
			user("u-probe-policy", "When should the research UI show the confidence badge?"),
		],
	});

	scenarios.push({
		name: "exact-command",
		category: "exact",
		key: "pnpm exec playwright test --project=chromium-admin",
		probe: "What exact command did we keep for the admin browser regression?",
		messages: [
			user("u-command", "Save the browser regression command."),
			assistant(
				"a-command",
				[
					"The smoke command npm run test:e2e is too broad for the admin-only path.",
					"The exact command we kept for the admin browser regression is pnpm exec playwright test --project=chromium-admin.",
				].join(" "),
			),
			...fillerTurns("command-filler", 11, 90),
			user("u-probe-command", "What exact command did we keep for the admin browser regression?"),
		],
	});

	scenarios.push({
		name: "semantic-cache-store",
		category: "semantic",
		key: "standardize on Redis",
		aliases: ["redis"],
		forbiddenAnswerTerms: ["memcached", "local memory"],
		probe: "Which backend should provide shared ephemeral state across app instances?",
		messages: [
			user("u-sem-cache", "Resolve the cross-process state store."),
			assistant(
				"a-sem-cache",
				"We compared Memcached, local memory, and Redis. The final decision was to standardize on Redis for shared ephemeral state across app instances.",
			),
			...fillerTurns("sem-cache-filler", 13, 80),
			user("u-probe-sem-cache", "Which backend should provide shared ephemeral state across app instances?"),
		],
	});

	scenarios.push({
		name: "semantic-offline-sync",
		category: "semantic",
		key: "queue writes until reconnect",
		aliases: ["queue writes", "replay them in original order"],
		probe: "How should disconnected edits be handled before the network comes back?",
		messages: [
			user("u-sem-sync", "Resolve disconnected editing behavior."),
			assistant(
				"a-sem-sync",
				[
					"We discussed optimistic updates, conflict dialogs, retry timers, and draft banners.",
					"The final product decision was to queue writes until reconnect, then replay them in original order after a fresh server version check.",
				].join(" "),
			),
			...fillerTurns("sem-sync-filler", 14, 78),
			user("u-probe-sem-sync", "How should disconnected edits be handled before the network comes back?"),
		],
	});

	scenarios.push({
		name: "semantic-preference-late",
		category: "semantic",
		key: "ivy layout",
		aliases: ["ivy"],
		forbiddenAnswerTerms: ["blue variant", "compact variant", "tour-card variant"],
		probe: "Which onboarding design did Maya like?",
		messages: [
			user("u-sem-preference", "Record design review notes."),
			assistant(
				"a-sem-preference",
				[
					"The review covered spacing, typography, button density, blank-state illustrations, and how much motion was acceptable in the first-run flow.",
					"Several participants commented on the blue variant, the compact variant, and the tour-card variant before the discussion moved on.",
					"A late note from Maya said her preferred onboarding arrangement was the ivy layout because it grouped setup tasks by intent.",
				].join(" "),
			),
			...fillerTurns("sem-preference-filler", 14, 78),
			user("u-probe-sem-preference", "Which onboarding design did Maya like?"),
		],
	});

	scenarios.push({
		name: "semantic-dashboard-preference",
		category: "semantic",
		key: "opal panel",
		aliases: ["opal"],
		forbiddenAnswerTerms: ["grid concept", "timeline concept", "atlas concept"],
		probe: "Which dashboard concept did Rina prefer?",
		messages: [
			user("u-sem-dashboard", "Record dashboard review notes."),
			assistant(
				"a-sem-dashboard",
				[
					"The critique wandered through spacing, icon density, chart legends, empty states, animation speed, and how much explanation belonged above the fold.",
					"Rina reacted politely to the grid concept, the timeline concept, and the atlas concept while the group compared tradeoffs.",
					"Her quiet favorite, mentioned near the end after the room had moved on, was the opal panel because it let operators scan exceptions first.",
				].join(" "),
			),
			...fillerTurns("sem-dashboard-filler", 14, 78),
			user("u-probe-sem-dashboard", "Which dashboard concept did Rina prefer?"),
		],
	});

	scenarios.push({
		name: "semantic-accessibility-preference",
		category: "semantic",
		key: "copper ramp",
		aliases: ["copper"],
		forbiddenAnswerTerms: ["glass lift", "folding stair", "side elevator"],
		probe: "What entrance treatment did Omar favor for accessibility?",
		messages: [
			user("u-sem-access", "Capture the entrance review."),
			assistant(
				"a-sem-access",
				[
					"The notes covered signage contrast, doorway width, rain runoff, nighttime lighting, delivery access, and where visitors would naturally queue.",
					"Omar listened while people discussed the glass lift, the folding stair, and the side elevator as possible approaches.",
					"For accessibility, Omar favored the copper ramp because it gave the main entrance a single continuous path without requiring a separate call button.",
				].join(" "),
			),
			...fillerTurns("sem-access-filler", 14, 78),
			user("u-probe-sem-access", "What entrance treatment did Omar favor for accessibility?"),
		],
	});

	scenarios.push({
		name: "semantic-crash-owner",
		category: "semantic",
		key: "lantern parser",
		aliases: ["lantern"],
		forbiddenAnswerTerms: ["billing adapter", "calendar bridge", "retry worker"],
		probe: "Which component did Leena blame for the timezone crash?",
		messages: [
			user("u-sem-crash", "Log the timezone crash discussion."),
			assistant(
				"a-sem-crash",
				[
					"We reviewed traces from the billing adapter, the calendar bridge, the retry worker, and the account export path before the team lost patience with the stack logs.",
					"Leena said the timezone crash came from the lantern parser because it normalized midnight before applying the account locale.",
				].join(" "),
			),
			...fillerTurns("sem-crash-filler", 14, 78),
			user("u-probe-sem-crash", "Which component did Leena blame for the timezone crash?"),
		],
	});

	scenarios.push({
		name: "semantic-launch-rehearsal",
		category: "semantic",
		key: "northstar rehearsal",
		aliases: ["northstar"],
		forbiddenAnswerTerms: ["redwood drill", "harbor check", "summit review"],
		probe: "What practice run did Theo want before launch?",
		messages: [
			user("u-sem-launch", "Keep the launch readiness notes."),
			assistant(
				"a-sem-launch",
				[
					"The launch discussion covered pager rotation, rollback wording, customer comms, status-page templates, and who would watch the data pipeline.",
					"Theo was not worried about the redwood drill, the harbor check, or the summit review; before launch he wanted the northstar rehearsal so support could practice the handoff.",
				].join(" "),
			),
			...fillerTurns("sem-launch-filler", 14, 78),
			user("u-probe-sem-launch", "What practice run did Theo want before launch?"),
		],
	});

	return scenarios;
}

function fillerTurns(prefix: string, count: number, repeats: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push(user(`u-${prefix}-${i}`, `Continue implementation area ${i}.`));
		messages.push(assistant(`a-${prefix}-${i}`, fillerText(`${prefix}-${i}`, repeats)));
	}
	return messages;
}

function tokensOf(messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estTokens(textOf([message])) + 4, 0);
}

function textOf(messages: AgentMessage[]): string {
	return messages.map((message) => {
		const content = (message as any).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.map((part) => part.text ?? part.thinking ?? JSON.stringify(part)).join("\n");
	}).join("\n");
}

function compactClip(text: string, maxChars: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= maxChars ? normalized : normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
}

function compactDecisionSentence(text: string): string {
	const sentences = text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	return sentences.find((sentence) =>
		/\b(?:actual|belongs to|decision|decided|final|selected|chosen|we chose|we will)\b/i.test(sentence),
	) ?? "";
}

function compactSalienceTokens(text: string, maxItems = 5, maxChars = 120): string {
	const seen = new Set<string>();
	const result: string[] = [];
	let totalChars = 0;
	const add = (value: string) => {
		const token = value.trim();
		if (!token || seen.has(token) || result.length >= maxItems || totalChars + token.length > maxChars) return;
		seen.add(token);
		result.push(token);
		totalChars += token.length;
	};
	for (const match of text.matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+/g)) add(match[0]);
	for (const match of text.matchAll(/\b[\w.-]+\.\w{1,6}\b/g)) add(match[0]);
	for (const match of text.matchAll(/\b(?:error|exception|failed|panic)[: ]+\S+/gi)) add(match[0].slice(0, 30));
	return result.join(" · ");
}

function compactBaselineDigest(block: ContextBlock): string {
	if (block.kind === "text") {
		const decision = compactDecisionSentence(block.text);
		const salience = compactSalienceTokens(block.text);
		if (decision && salience && !decision.includes(salience)) return `${compactClip(decision, 180)} | ${salience}`;
		return decision ? compactClip(decision, 180) : salience || compactClip(block.text, 120);
	}
	if (block.kind === "tool_result") return compactSalienceTokens(block.text) || compactClip(block.text, 80);
	return compactClip(block.text, 100);
}

function messagesFromBlocks(blocks: ContextBlock[]): AgentMessage[] {
	return blocks.map((block, index) => ({
		id: `ctx-${index}`,
		role: block.kind === "user" ? "user" : "assistant",
		content: [txt(block.text)],
	}));
}

function recencyContext(messages: AgentMessage[], budget: number): AgentMessage[] {
	const blocks = parseMessages(messages).blocks;
	let tokens = 0;
	const kept: ContextBlock[] = [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (tokens + blocks[i].tokens > budget) break;
		tokens += blocks[i].tokens;
		kept.unshift(blocks[i]);
	}
	return messagesFromBlocks(kept);
}

export function compactContext(messages: AgentMessage[], budget: number): AgentMessage[] {
	const parsed = parseMessages(messages);
	const latest = parsed.turns.at(-1)?.index ?? 0;
	const tail = parsed.blocks.filter((block) => block.turn === latest);
	const tailMessages = messagesFromBlocks(tail);
	const tailTokens = tokensOf(tailMessages);
	const summaryBudget = Math.max(80, budget - tailTokens);
	const older = parsed.blocks.filter((block) => block.turn !== latest);
	const summaryLines: string[] = [];
	let used = 0;

	for (const block of older) {
		const line = `turn ${block.turn} ${block.kind}: ${compactBaselineDigest(block)}`;
		const lineTokens = Math.ceil(line.length / 4) + 4;
		if (used + lineTokens > summaryBudget) continue;
		summaryLines.push(line);
		used += lineTokens;
	}

	return [
		{
			id: "compact-summary",
			role: "compactionSummary",
			summary: `Compact summary of earlier conversation:\n${summaryLines.join("\n")}`,
			content: [txt(`Compact summary of earlier conversation:\n${summaryLines.join("\n")}`)],
		},
		...tailMessages,
	];
}

function compactSummaryContext(messages: AgentMessage[], summary: string, id: string): AgentMessage[] {
	const parsed = parseMessages(messages);
	const latest = parsed.turns.at(-1)?.index ?? 0;
	const tail = parsed.blocks.filter((block) => block.turn === latest);
	const tailMessages = messagesFromBlocks(tail);
	return [
		{
			id,
			role: "compactionSummary",
			summary,
			content: [txt(`Compact summary of earlier conversation:\n${summary}`)],
		},
		...tailMessages,
	];
}

function clampToTokenBudget(text: string, budget: number): string {
	const targetChars = Math.max(0, budget - 4) * 4;
	if (text.length <= targetChars) return text;
	return text.slice(0, Math.max(0, targetChars - 3)).trimEnd() + "...";
}

async function llmCompactContext(
	messages: AgentMessage[],
	budget: number,
	model: string,
	baseUrl: string,
): Promise<AgentMessage[]> {
	const parsed = parseMessages(messages);
	const latest = parsed.turns.at(-1)?.index ?? 0;
	const tail = parsed.blocks.filter((block) => block.turn === latest);
	const tailMessages = messagesFromBlocks(tail);
	const tailTokens = tokensOf(tailMessages);
	const summaryBudget = Math.max(80, budget - tailTokens);
	const older = parsed.blocks.filter((block) => block.turn !== latest);
	const source = older.map((block) => `turn ${block.turn} ${block.kind}: ${block.text}`).join("\n\n");
	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			temperature: 0,
			max_tokens: Math.max(80, Math.min(600, summaryBudget)),
			stream: false,
			messages: [
				{ role: "system", content: COMPACT_SYSTEM_PROMPT },
				{
					role: "user",
					content:
						`Compact the older conversation into at most ~${summaryBudget} tokens. ` +
						`Do not answer the final user prompt. Preserve exact strings only when they seem durable.\n\n${source}`,
				},
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`compact model ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const json = await response.json() as any;
	const summary = clampToTokenBudget(json.choices?.[0]?.message?.content ?? "", summaryBudget);
	return compactSummaryContext(messages, summary, "llm-compact-summary");
}

export async function accordionContext(
	messages: AgentMessage[],
	probe: string,
	budget: number,
	embeddingProvider?: EmbeddingProvider,
	useLocalModel = false,
	modelArtifact?: ConductorModelArtifact,
	modelAuthority?: ConductorModelAuthority,
): Promise<AgentMessage[]> {
	const state = createAccordionState();
	const modelDeps: ConductorDependencies = useLocalModel
		? {
				...(modelArtifact ? createArtifactConductorModelProviders(modelArtifact, modelAuthority) : createLocalConductorModelProviders()),
				shadowMode: false,
			}
		: {};
	for (let end = 1; end <= messages.length; end++) {
		const prefix = messages.slice(0, end);
		const prompt = (prefix.at(-1) as any)?.role === "user" ? textOf([prefix.at(-1)!]) : "continue";
		const parsed = parseMessages(prefix);
		if (embeddingProvider) await warmEmbeddings(parsed.blocks, prompt, embeddingProvider, state);
		if (useLocalModel) await warmConductorModel({ blocks: parsed.blocks, prompt, messages: prefix, state }, modelDeps);
		const output = runConductor({
			messages: prefix,
			incomingPrompt: prompt,
			lastCompletedTurn: null,
			budgetTokens: budget,
			state,
			workingTailTokens: 0,
		}, modelDeps);
		for (const decision of output.decisions) {
			if (decision.action === "fold") {
				state.foldLevels[decision.blockId] = decision.level && decision.level > 0 ? decision.level : 2;
				if (!state.foldedBlockIds.includes(decision.blockId)) {
					state.foldedBlockIds.push(decision.blockId);
				}
			} else if (decision.action === "unfold") {
				const easedLevel = decision.level ?? 0;
				if (easedLevel > 0) {
					state.foldLevels[decision.blockId] = easedLevel;
					if (!state.foldedBlockIds.includes(decision.blockId)) {
						state.foldedBlockIds.push(decision.blockId);
					}
				} else {
					delete state.foldLevels[decision.blockId];
					state.foldedBlockIds = state.foldedBlockIds.filter((id) => id !== decision.blockId);
				}
			}
		}
	}
	const parsed = parseMessages(messages);
	if (embeddingProvider) await warmEmbeddings(parsed.blocks, probe, embeddingProvider, state);
	if (useLocalModel) await warmConductorModel({ blocks: parsed.blocks, prompt: probe, messages, state }, modelDeps);
	return runConductor({
		messages,
		incomingPrompt: probe,
		lastCompletedTurn: null,
		budgetTokens: budget,
		state,
		workingTailTokens: 0,
	}, { ...modelDeps, embeddingProvider }).messages;
}

function scoreContext(messages: AgentMessage[], key: string, budget: number): StrategyResult {
	const tokens = tokensOf(messages);
	const hasKey = textOf(messages).toLowerCase().includes(key.toLowerCase());
	return {
		tokens,
		withinBudget: tokens <= budget,
		hasKey,
		score: tokens <= budget && hasKey ? 1 : 0,
	};
}

function answerMatches(answer: string, scenario: Scenario): boolean {
	const lower = answer.toLowerCase();
	if ((scenario.forbiddenAnswerTerms ?? []).some((term) => lower.includes(term.toLowerCase()))) return false;
	return [scenario.key, ...(scenario.aliases ?? [])].some((key) => lower.includes(key.toLowerCase()));
}

function summarizeProof(cells: ComparisonCell[]): ProofSummary {
	const wins = cells.filter((cell) => (cell.accordion.score ?? 0) > (cell.compact.score ?? 0));
	const losses = cells.filter((cell) => (cell.accordion.score ?? 0) < (cell.compact.score ?? 0));
	const ties = cells.length - wins.length - losses.length;
	const accordionAvg = cells.reduce((sum, cell) => sum + (cell.accordion.score ?? 0), 0) / Math.max(1, cells.length);
	const compactAvg = cells.reduce((sum, cell) => sum + (cell.compact.score ?? 0), 0) / Math.max(1, cells.length);
	return {
		cells: cells.length,
		accordionScore: Math.round(accordionAvg * 1000) / 1000,
		compactScore: Math.round(compactAvg * 1000) / 1000,
		accordionWinsVsCompact: wins.length,
		compactWinsVsAccordion: losses.length,
		tiesVsCompact: ties,
		accordionBudgetViolations: cells.filter((cell) => !cell.accordion.withinBudget).length,
		compactBudgetViolations: cells.filter((cell) => !cell.compact.withinBudget).length,
		accordionAdvantagePoints: Math.round((accordionAvg - compactAvg) * 1000) / 10,
		representativeWins: wins.slice(0, 5).map((cell) => ({
			scenario: cell.scenario,
			budget: cell.budget,
			compactTokens: cell.compact.tokens,
			accordionTokens: cell.accordion.tokens,
			compactAnswer: cell.compact.answer,
			accordionAnswer: cell.accordion.answer,
		})),
	};
}

function renderMarkdownReport(
	report: {
		meta: Record<string, unknown>;
		retrievability: Record<string, number>;
		proofSummary: ProofSummary;
		cells: ComparisonCell[];
	},
	compactLabel: string,
): string {
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	const lines = [
		"# Accordion Compact Comparison",
		"",
		`Source JSON: ${basename(String(report.meta.outFile ?? "compact-comparison.json"))}`,
		`Cells: ${report.proofSummary.cells}`,
		`Mode: compact=${report.meta.compactMode}, embeddings=${report.meta.embeddings}, answers=${report.meta.withAnswers}`,
		`Model: ${report.meta.model}`,
		"",
		"## Scores",
		"",
		`- Recency truncation: ${pct(report.retrievability["recency-truncation"] ?? 0)}`,
		`- ${compactLabel}: ${pct(report.retrievability[compactLabel] ?? 0)}`,
		`- Accordion: ${pct(report.retrievability.accordion ?? 0)}`,
		`- Accordion advantage over ${compactLabel}: ${report.proofSummary.accordionAdvantagePoints} percentage points`,
		"",
		"## Head-to-Head",
		"",
		`- Accordion wins: ${report.proofSummary.accordionWinsVsCompact}`,
		`- ${compactLabel} wins: ${report.proofSummary.compactWinsVsAccordion}`,
		`- Ties: ${report.proofSummary.tiesVsCompact}`,
		`- Accordion budget violations: ${report.proofSummary.accordionBudgetViolations}`,
		`- ${compactLabel} budget violations: ${report.proofSummary.compactBudgetViolations}`,
		"",
		"## Representative Accordion Wins",
		"",
	];
	if (report.proofSummary.representativeWins.length === 0) {
		lines.push("No Accordion-only wins in this run.");
	} else {
		for (const win of report.proofSummary.representativeWins) {
			lines.push(`- ${win.scenario} @ budget ${win.budget}: ${compactLabel}=${win.compactTokens} tok, Accordion=${win.accordionTokens} tok`);
			if (win.compactAnswer || win.accordionAnswer) {
				lines.push(`  - ${compactLabel} answer: ${win.compactAnswer ?? "(no answer scored)"}`);
				lines.push(`  - Accordion answer: ${win.accordionAnswer ?? "(no answer scored)"}`);
			}
		}
	}
	lines.push("");
	return lines.join("\n");
}

function externalKey(scenario: string, budget: number): string {
	return `${scenario}:${budget}`;
}

function messageText(message: AgentMessage): string {
	return textOf([message]);
}

export function buildExternalTemplate(scenarios: Scenario[], budgets: number[]): ExternalCompactFixture[] {
	return scenarios.flatMap((scenario) =>
		budgets.map((budget) => {
			const setupMessages = scenario.messages.slice(0, -1);
			const finalMessage = scenario.messages.at(-1);
			return {
				scenario: scenario.name,
				budget,
				summary: "",
				captureProtocol: "Replay setupTranscript, invoke /compact, paste the resulting summary here, then score with finalPrompt.",
				finalPrompt: finalMessage ? messageText(finalMessage) : scenario.probe,
				probe: scenario.probe,
				key: scenario.key,
				aliases: scenario.aliases ?? [],
				forbiddenAnswerTerms: scenario.forbiddenAnswerTerms ?? [],
				setupTranscript: setupMessages.map((message) => ({
					role: String((message as any).role ?? "unknown"),
					text: messageText(message),
				})),
			};
		}),
	);
}

export function renderExternalCaptureGuide(fixtures: ExternalCompactFixture[]): string {
	const lines = [
		"# Accordion Real /compact Capture Guide",
		"",
		"Use this guide to collect host `/compact` outputs without leaking the final evaluation prompt into the compacted setup.",
		"",
		"For each entry:",
		"",
		"1. Start a fresh host conversation.",
		"2. Replay only the listed setup transcript messages.",
		"3. Invoke `/compact` before sending the final prompt.",
		"4. Paste the produced compact summary into the matching `summary` field in `compact-captures.json`.",
		"5. Do not send the final prompt during capture; the scorer adds it later.",
		"",
	];

	for (const fixture of fixtures) {
		const setup = fixture.setupTranscript ?? fixture.transcript ?? [];
		lines.push(
			`## ${fixture.scenario} @ budget ${fixture.budget}`,
			"",
			`Expected key: ${fixture.key ?? "(not specified)"}`,
			`Final prompt, do not send before /compact: ${fixture.finalPrompt ?? fixture.probe ?? "(not specified)"}`,
			"",
			"### Capture Steps",
			"",
			`- Replay the ${setup.length} messages in this fixture's JSON \`setupTranscript\` field.`,
			"- Invoke `/compact` immediately after the last setup message.",
			"- Paste the compacted summary into this fixture's JSON `summary` field.",
			"",
			"### Setup Preview",
			"",
		);
		for (const [index, message] of setup.slice(0, 3).entries()) {
			lines.push(`- ${index + 1}. ${message.role}: ${message.text.replace(/\s+/g, " ").slice(0, 220)}`);
		}
		if (setup.length > 3) lines.push(`- ... ${setup.length - 3} more setup messages in \`compact-captures.template.json\``);
		lines.push("");
	}

	return lines.join("\n");
}

export function normalizeExternalFixtures(json: unknown): ExternalCompactFixture[] {
	if (Array.isArray(json)) return json as ExternalCompactFixture[];
	if (json && typeof json === "object") {
		const obj = json as any;
		if (Array.isArray(obj.entries)) return obj.entries as ExternalCompactFixture[];
		if (Array.isArray(obj.compacts)) return obj.compacts as ExternalCompactFixture[];
		const fixtures: ExternalCompactFixture[] = [];
		for (const [key, value] of Object.entries(obj)) {
			const [scenario, budgetText] = key.split(":");
			if (!scenario || !budgetText) continue;
			fixtures.push({
				scenario,
				budget: Number(budgetText),
				summary: typeof value === "string" ? value : String((value as any)?.summary ?? ""),
			});
		}
		return fixtures;
	}
	return [];
}

export function readExternalCompacts(file: string, allowEmpty: boolean): Map<string, string> {
	const fixtures = normalizeExternalFixtures(JSON.parse(readFileSync(file, "utf8")));
	const map = new Map<string, string>();
	for (const fixture of fixtures) {
		if (!fixture.scenario || !Number.isFinite(fixture.budget)) continue;
		const summary = fixture.summary ?? "";
		if (!allowEmpty && summary.trim().length === 0) {
			throw new Error(
				`External compact summary is empty for ${fixture.scenario} budget ${fixture.budget}. ` +
				`Paste real /compact output or rerun with --allow-empty-external for parser smoke tests only.`,
			);
		}
		map.set(externalKey(fixture.scenario, fixture.budget), summary);
	}
	return map;
}

function numericFlag(argv: string[], name: string): number | undefined {
	const value = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name} value: ${value}`);
	return parsed;
}

function stringFlag(argv: string[], name: string): string | undefined {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	if (inline !== undefined) return inline;
	const index = argv.indexOf(`--${name}`);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	return value && !value.startsWith("--") ? value : undefined;
}

function enforceProofGates(summary: ProofSummary, gates: {
	minCells?: number;
	minAdvantage?: number;
	minAccordionScore?: number;
	maxCompactWins?: number;
	maxAccordionBudgetViolations?: number;
	maxCompactBudgetViolations?: number;
}): string[] {
	const failures: string[] = [];
	if (gates.minCells !== undefined && summary.cells < gates.minCells) {
		failures.push(`Cells ${summary.cells} < required ${gates.minCells}`);
	}
	if (gates.minAdvantage !== undefined && summary.accordionAdvantagePoints < gates.minAdvantage) {
		failures.push(`Accordion advantage ${summary.accordionAdvantagePoints}pp < required ${gates.minAdvantage}pp`);
	}
	if (
		gates.minAccordionScore !== undefined &&
		Math.round(summary.accordionScore * 1000) / 10 < gates.minAccordionScore
	) {
		failures.push(
			`Accordion score ${Math.round(summary.accordionScore * 1000) / 10}pp < required ${gates.minAccordionScore}pp`,
		);
	}
	if (gates.maxCompactWins !== undefined && summary.compactWinsVsAccordion > gates.maxCompactWins) {
		failures.push(`Compact wins ${summary.compactWinsVsAccordion} > allowed ${gates.maxCompactWins}`);
	}
	if (
		gates.maxAccordionBudgetViolations !== undefined &&
		summary.accordionBudgetViolations > gates.maxAccordionBudgetViolations
	) {
		failures.push(
			`Accordion budget violations ${summary.accordionBudgetViolations} > allowed ${gates.maxAccordionBudgetViolations}`,
		);
	}
	if (
		gates.maxCompactBudgetViolations !== undefined &&
		summary.compactBudgetViolations > gates.maxCompactBudgetViolations
	) {
		failures.push(`Compact budget violations ${summary.compactBudgetViolations} > allowed ${gates.maxCompactBudgetViolations}`);
	}
	return failures;
}

async function answerContext(messages: AgentMessage[], probe: string, model: string, baseUrl: string): Promise<string> {
	const payload = {
		model,
		temperature: 0,
		max_tokens: 120,
		stream: false,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: textOf(messages) },
			{ role: "user", content: probe },
		],
	};
	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(120_000),
	});
	if (!response.ok) throw new Error(`answer model ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const json = await response.json() as any;
	return json.choices?.[0]?.message?.content ?? "";
}

async function main() {
	const argv = process.argv.slice(2);
	const budgets = (argv.find((arg) => arg.startsWith("--budgets="))?.split("=")[1]?.split(",").map(Number)) ?? DEFAULT_BUDGETS;
	const outFile = argv.find((arg) => arg.startsWith("--out="))?.split("=")[1] ?? DEFAULT_OUT;
	const markdownFile = argv.find((arg) => arg.startsWith("--markdown="))?.split("=")[1];
	const withAnswers = argv.includes("--answers");
	const withEmbeddings = argv.includes("--embeddings");
	const useLocalModel = argv.includes("--local-model");
	const modelArtifactFile = stringFlag(argv, "model-artifact");
	const modelAuthorityFile = stringFlag(argv, "model-authority");
	const compactMode = (argv.find((arg) => arg.startsWith("--compact="))?.split("=")[1] ?? "deterministic") as CompactMode;
	if (!["deterministic", "external", "llm"].includes(compactMode)) {
		throw new Error(`Invalid --compact mode: ${compactMode}`);
	}
	const externalCompactFile = argv.find((arg) => arg.startsWith("--external-compact="))?.split("=")[1];
	const externalTemplateFile = argv.find((arg) => arg.startsWith("--write-external-template="))?.split("=")[1];
	const externalGuideFile = argv.find((arg) => arg.startsWith("--write-external-guide="))?.split("=")[1];
	const allowEmptyExternal = argv.includes("--allow-empty-external");
	const scenarioFilter = argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
	const categoryFilter = argv.find((arg) => arg.startsWith("--category="))?.split("=")[1];
	const gates = {
		minCells: numericFlag(argv, "min-cells"),
		minAdvantage: numericFlag(argv, "min-advantage"),
		minAccordionScore: numericFlag(argv, "min-accordion-score"),
		maxCompactWins: numericFlag(argv, "max-compact-wins"),
		maxAccordionBudgetViolations: numericFlag(argv, "max-accordion-budget-violations"),
		maxCompactBudgetViolations: numericFlag(argv, "max-compact-budget-violations"),
	};
	const model = argv.find((arg) => arg.startsWith("--model="))?.split("=")[1] ?? "llama3.2:3b";
	const baseUrl = argv.find((arg) => arg.startsWith("--base-url="))?.split("=")[1] ?? "http://localhost:11434/v1";
	const scenarios = buildScenarios().filter((scenario) => {
		if (scenarioFilter && scenario.name !== scenarioFilter) return false;
		if (categoryFilter && scenario.category !== categoryFilter) return false;
		return true;
	});
	if (externalTemplateFile) {
		const template = buildExternalTemplate(scenarios, budgets);
		writeFileSync(externalTemplateFile, JSON.stringify(template, null, 2));
		process.stdout.write(`External compact capture template written to ${externalTemplateFile}\n`);
		if (externalGuideFile) {
			writeFileSync(externalGuideFile, renderExternalCaptureGuide(template));
			process.stdout.write(`External compact capture guide written to ${externalGuideFile}\n`);
		}
		return;
	}
	const externalCompacts = compactMode === "external"
		? readExternalCompacts(
			externalCompactFile ?? (() => { throw new Error("--compact=external requires --external-compact=<file>"); })(),
			allowEmptyExternal,
		)
		: undefined;
	const embeddingProvider = withEmbeddings ? await createTransformersEmbeddingProvider() : undefined;
	const modelArtifact = modelArtifactFile ? parseConductorModelArtifact(readFileSync(modelArtifactFile, "utf8")) : undefined;
	const modelAuthority = loadConductorModelAuthority({
		artifactFile: modelArtifactFile,
		authorityFile: modelAuthorityFile,
	});

	const cells: ComparisonCell[] = [];
	for (const scenario of scenarios) {
		for (const budget of budgets) {
			const recencyMessages = recencyContext(scenario.messages, budget);
			const compactMessages = compactMode === "llm"
				? await llmCompactContext(scenario.messages, budget, model, baseUrl)
				: compactMode === "external"
					? compactSummaryContext(
						scenario.messages,
						externalCompacts?.get(externalKey(scenario.name, budget)) ??
							(() => { throw new Error(`Missing external compact summary for ${scenario.name} budget ${budget}`); })(),
						"external-compact-summary",
					)
					: compactContext(scenario.messages, budget);
			const accordionMessages = await accordionContext(
				scenario.messages,
				scenario.probe,
				budget,
				embeddingProvider,
				useLocalModel,
				modelArtifact,
				modelAuthority.authority,
			);
			const recency = scoreContext(recencyMessages, scenario.key, budget);
			const compact = scoreContext(compactMessages, scenario.key, budget);
			const accordion = scoreContext(accordionMessages, scenario.key, budget);

			if (withAnswers) {
				for (const [result, context] of [
					[recency, recencyMessages],
					[compact, compactMessages],
					[accordion, accordionMessages],
				] as const) {
					if (!result.withinBudget) continue;
					result.answer = await answerContext(context, scenario.probe, model, baseUrl);
					result.score = answerMatches(result.answer, scenario) ? 1 : 0;
				}
			}

			cells.push({ scenario: scenario.name, budget, recency, compact, accordion });
			process.stdout.write(
				`${scenario.name} budget=${budget} recency=${recency.score} compact=${compact.score} accordion=${accordion.score}` +
				` tokens(${recency.tokens}/${compact.tokens}/${accordion.tokens})\n`,
			);
		}
	}

	const compactLabel = compactMode === "llm"
		? "llm-compact"
		: compactMode === "external"
			? "external-compact"
			: "summarize-then-drop";
	const avg = (name: "recency" | "compact" | "accordion") =>
		cells.reduce((sum, cell) => sum + (cell[name].score ?? 0), 0) / Math.max(1, cells.length);
	const report = {
		meta: {
			date: new Date().toISOString(),
			budgets,
			withAnswers,
			compactMode,
			embeddings: withEmbeddings,
			localModel: useLocalModel,
			modelArtifact: modelArtifactFile,
			modelAuthority: modelAuthority.file,
			modelAuthorityImplicit: modelAuthority.implicit,
			scenarioFilter,
			categoryFilter,
			outFile,
			model,
			baseUrl,
		},
		retrievability: {
			"recency-truncation": avg("recency"),
			[compactLabel]: avg("compact"),
			accordion: avg("accordion"),
		},
		proofSummary: summarizeProof(cells),
		cells,
	};
	writeFileSync(outFile, JSON.stringify(report, null, 2));
	if (markdownFile) writeFileSync(markdownFile, renderMarkdownReport(report, compactLabel));
	process.stdout.write(`\nResults written to ${outFile}\n`);
	if (markdownFile) process.stdout.write(`Markdown report written to ${markdownFile}\n`);
	process.stdout.write(JSON.stringify(report.retrievability, null, 2) + "\n");
	process.stdout.write(JSON.stringify(report.proofSummary, null, 2) + "\n");
	const failures = enforceProofGates(report.proofSummary, gates);
	if (failures.length > 0) {
		for (const failure of failures) process.stderr.write(`[FAIL] ${failure}\n`);
		process.exitCode = 1;
	} else if (Object.values(gates).some((value) => value !== undefined)) {
		process.stdout.write("Proof gates passed.\n");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
