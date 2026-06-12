import { readFileSync, writeFileSync } from "node:fs";
import { loadConductorModelAuthority } from "./conductor-model-authority.ts";
import {
	DEFAULT_OLLAMA_BASE_URL,
	DEFAULT_OLLAMA_MODEL,
	CHARS_PER_TOKEN,
	UNFOLD_KEYWORD_THRESHOLD,
	createAccordionState,
	createArtifactConductorModelProviders,
	createLocalConductorModelProviders,
	createOllamaSummaryProvider,
	createTransformersEmbeddingProvider,
	estTokens,
	keywordOverlap,
	parseMessages,
	parseConductorModelArtifact,
	runConductor,
	textHash,
	tokenizeForRelevance,
	warmEmbeddings,
	warmConductorModel,
	type AgentMessage,
	type ConductorDependencies,
	type ConductorModelAuthority,
	type ConductorModelArtifact,
} from "./conductor.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Config {
	model: string;
	baseUrl: string;
	apiKey: string;
	lengths: number[];
	depths: number[];
	budgets: number[];
	runs: number;
	summary: boolean;
	embeddings: boolean;
	localModel: boolean;
	modelArtifactFile?: string;
	modelAuthorityFile?: string;
	modelAuthority?: ConductorModelAuthority;
	modelAuthorityImplicit?: boolean;
	offlineAnswer: boolean;
	workingTailTokens?: number;
	mode: "single" | "multi-key";
	probe: "direct" | "indirect" | "realistic";
	filler: "repeat" | "varied";
	verbose: boolean;
	outFile: string;
}

interface CellResult {
	length: number;
	depth: number | null;
	budget: number;
	run: number;
	probe: string;
	baselineScore: number;
	accordionScore: number;
	needleFolded: boolean;
	needleRescued: boolean;
	falseUnfolds: number;
	inputTokens: number;
	foldedTokens: number;
	savedTokens: number;
	effectiveFoldRatio: number;
	foldDecisions: number;
	durationMs: number;
}

interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_call_id?: string;
	tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface BenchmarkResults {
	meta: {
		date: string;
		model: string;
		baseUrl: string;
		mode: string;
		probe: string;
		runs: number;
		embeddings: boolean;
		modelArtifact?: string;
		modelAuthority?: string;
		modelAuthorityImplicit?: boolean;
		notes: string[];
	};
	cells: CellResult[];
	summary: Record<string, number>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Direct probe: shares "emergency", "rollback", "passphrase" with needle text.
// The conductor's proactive-unfold (keyword overlap ≥ 0.5) will rescue a folded
// needle back to full — so this tests the BEST CASE for Accordion.
export const NEEDLE = "The emergency rollback passphrase is: MANGO-WHISPER-9";
const NEEDLE_KEY = "MANGO-WHISPER-9";
const PROBE_DIRECT = "What is the emergency rollback passphrase? Answer with just the passphrase.";

// Indirect probe: no shared keywords with the needle. The conductor has no signal
// to rescue the folded block. Tests whether the DIGEST alone preserves the needle.
const PROBE_INDIRECT = "A critical incident occurred. What code do I need to enter?";

// Realistic probe: semantically related to the needle (about reverting/secrets)
// but uses ZERO overlapping tokens — isolating Stage 2 (embedding) from Stage 1
// (keyword). Lexical isolation is verified at startup by assertLexicalIsolation().
export const PROBE_REALISTIC = "Remind me of the secret we need to revert the deployment.";
export const MULTI_PROBE_REALISTIC =
	"List the three credentials we stored for reverting a release, pushing to prod, and restoring after an outage.";

export const MULTI_NEEDLES = [
	{ text: "The emergency rollback passphrase is: MANGO-WHISPER-9", key: "MANGO-WHISPER-9" },
	{ text: "The primary deployment token is: COBALT-REEF-7", key: "COBALT-REEF-7" },
	{ text: "The disaster recovery key is: VIOLET-STORM-42", key: "VIOLET-STORM-42" },
];
const MULTI_PROBE_DIRECT =
	"What are the emergency rollback passphrase, the primary deployment token, and the disaster recovery key? List each value.";
const MULTI_PROBE_INDIRECT = "A critical incident occurred. What codes do I need to enter? List all of them.";
// MULTI_PROBE_REALISTIC defined above alongside PROBE_REALISTIC
const MULTI_NEEDLE_DEPTHS = [0.25, 0.5, 0.75];

// ID prefix for the needle tool result — used to detect if it was folded/rescued
export const NEEDLE_RESULT_ID_PREFIX = "r-needle-";
// Needle TURN block prefix — includes the assistant message carrying the tool_call.
// Pairing means both are unfolded together; exclude from false-unfold counting.
export const NEEDLE_TURN_ID_PREFIX = "a-needle-";

const TARGET_TURN_TOKENS = 300;
const SYSTEM_PROMPT =
	"You are a helpful assistant. Answer questions based only on the conversation history provided. Be concise and direct.";

// ── Varied filler ────────────────────────────────────────────────────────────

// Mundane developer/ops log lines — NO secrets, passphrases, tokens, credentials,
// rollback, recovery, or deployment-key language. Safe to use as embedding noise.
const VARIED_FILLER_POOL = [
	"Compiled 3 source files in 0.42s",
	"Lint check passed — 0 warnings",
	"847 unit tests passed in 12.3s",
	"npm install: 312 packages installed, 0 vulnerabilities",
	"Bundle size: 2.1 MB gzipped 680 KB",
	"Database migration 20240115_add_index applied",
	"Type check completed — 0 errors",
	"Cache cleared: 14 stale entries removed",
	"Build artifacts removed from /tmp/build",
	"HTTP 200 GET /api/health — 3ms",
	"Formatted 28 files with prettier",
	"Worker pool initialized with 4 threads",
	"Memory usage: 312 MB of 512 MB limit",
	"Scheduled task daily-cleanup ran at 03:00",
	"Log rotation: archived 7 files to /var/archive",
	"Schema validation passed: 18 models checked",
	"ESLint: 4 auto-fixable issues corrected",
	"Service health: 5 endpoints responding",
	"Dependency graph resolved in 0.8s",
	"Disk usage: 4.2 GB of 50 GB available",
];

function makeVariedText(turnIdx: number, targetTokens: number): string {
	const targetChars = targetTokens * CHARS_PER_TOKEN;
	let result = "";
	let lineIdx = 0;
	while (result.length < targetChars) {
		const poolIdx = (turnIdx * 7 + lineIdx * 3) % VARIED_FILLER_POOL.length;
		result += VARIED_FILLER_POOL[poolIdx] + "\n";
		lineIdx++;
	}
	return result.slice(0, targetChars).trim();
}

// ── Lexical isolation check ───────────────────────────────────────────────────

function assertLexicalIsolation(probe: string, needleTexts: string[]): void {
	const probeTokens = new Set(tokenizeForRelevance(probe));
	for (const needleText of needleTexts) {
		const needleTokens = new Set(tokenizeForRelevance(needleText));
		const shared = [...probeTokens].filter((t) => needleTokens.has(t));
		if (shared.length > 0) {
			process.stderr.write(`[FAIL] lexical isolation: probe shares [${shared.join(", ")}] with needle: "${needleText}"\n`);
			process.stderr.write(`       Rephrase the probe to remove shared tokens.\n`);
			process.exit(1);
		}
	}
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseCli(argv: string[]): Config {
	const cfg: Config = {
		model: DEFAULT_OLLAMA_MODEL,
		baseUrl: DEFAULT_OLLAMA_BASE_URL,
		apiKey: "",
		lengths: [2_000, 5_000, 10_000, 20_000],
		depths: [0.1, 0.25, 0.5, 0.75, 0.9],
		budgets: [1.0, 0.9, 0.7, 0.5],
		runs: 1,
		summary: false,
		embeddings: false,
		localModel: false,
		offlineAnswer: false,
		workingTailTokens: undefined,
		mode: "single",
		probe: "direct",
		filler: "repeat",
		verbose: false,
		outFile: "docs/benchmark-results.json",
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const val = argv[i + 1];
		if (flag === "--model") { cfg.model = val; i++; }
		else if (flag === "--base-url") { cfg.baseUrl = val; i++; }
		else if (flag === "--api-key") { cfg.apiKey = val; i++; }
		else if (flag === "--lengths") { cfg.lengths = val.split(",").map(Number); i++; }
		else if (flag === "--depths") { cfg.depths = val.split(",").map(Number); i++; }
		else if (flag === "--budgets") { cfg.budgets = val.split(",").map(Number); i++; }
		else if (flag === "--runs") { cfg.runs = parseInt(val, 10); i++; }
		else if (flag === "--summary") { cfg.summary = true; }
		else if (flag === "--embeddings") { cfg.embeddings = true; }
		else if (flag === "--offline-answer") { cfg.offlineAnswer = true; }
		else if (flag === "--working-tail-tokens") { cfg.workingTailTokens = parseInt(val, 10); i++; }
		else if (flag === "--local-model") { cfg.localModel = true; }
		else if (flag === "--model-artifact" || flag.startsWith("--model-artifact=")) {
			cfg.modelArtifactFile = flag.includes("=") ? flag.split("=")[1] : val;
			cfg.localModel = true;
			if (!flag.includes("=")) i++;
		}
		else if (flag === "--model-authority" || flag.startsWith("--model-authority=")) {
			cfg.modelAuthorityFile = flag.includes("=") ? flag.split("=")[1] : val;
			if (!flag.includes("=")) i++;
		}
		else if (flag === "--mode") { cfg.mode = val as "single" | "multi-key"; i++; }
		else if (flag === "--probe") { cfg.probe = val as "direct" | "indirect" | "realistic"; i++; }
		else if (flag === "--filler") { cfg.filler = val as "repeat" | "varied"; i++; }
		else if (flag === "--verbose") { cfg.verbose = true; }
		else if (flag === "--out") { cfg.outFile = val; i++; }
		else if (!flag.startsWith("--")) { /* positional */ }
		else { process.stderr.write(`[WARN] unknown flag: ${flag}\n`); }
	}
	return cfg;
}

function loadModelArtifact(cfg: Config): ConductorModelArtifact | undefined {
	return cfg.modelArtifactFile ? parseConductorModelArtifact(readFileSync(cfg.modelArtifactFile, "utf8")) : undefined;
}

// ── Haystack generation ───────────────────────────────────────────────────────

function makeText(prefix: string, startIdx: number, targetTokens: number): string {
	const targetChars = targetTokens * CHARS_PER_TOKEN;
	const word = `${prefix}_${startIdx}`;
	const repeated = (word + " ").repeat(Math.ceil(targetChars / (word.length + 1)));
	return repeated.slice(0, targetChars);
}

function makeTurn(idx: number, resultTokens: number, prefix: string, filler: "repeat" | "varied" = "repeat"): AgentMessage[] {
	const callId = `call-turn-${idx}`;
	const resultText = filler === "varied"
		? makeVariedText(idx, Math.max(10, resultTokens))
		: makeText(prefix, idx * 100, resultTokens);
	return [
		{
			id: `u-${idx}`,
			role: "user",
			content: [{ type: "text", text: `Continue task step ${idx}.` }],
		},
		{
			id: `a-${idx}`,
			role: "assistant",
			content: [
				{ type: "text", text: `Executing step ${idx}.` },
				{ type: "toolCall", id: callId, name: "bash", arguments: { command: `run_step_${idx}` } },
			],
		},
		{
			id: `r-${idx}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: resultText }],
			isError: false,
		},
	];
}

function makeNeedleTurn(idx: number, needleText: string): AgentMessage[] {
	const callId = `call-needle-${idx}`;
	return [
		{
			id: `u-needle-${idx}`,
			role: "user",
			content: [{ type: "text", text: `Log the following configuration value.` }],
		},
		{
			id: `a-needle-${idx}`,
			role: "assistant",
			content: [
				{ type: "text", text: `Logging the configuration.` },
				{ type: "toolCall", id: callId, name: "bash", arguments: { command: "log_config" } },
			],
		},
		{
			id: `${NEEDLE_RESULT_ID_PREFIX}${idx}`,
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: `Configuration log output:\n${needleText}` }],
			isError: false,
		},
	];
}

// Use the conductor's own parseMessages to count tokens, so budget ratios are in
// the same units the conductor uses internally (includes block overhead per block).
function tokensOfMessages(messages: AgentMessage[]): number {
	return parseMessages(messages).blocks.reduce((sum, block) => sum + block.tokens, 0);
}

export function buildHaystack(depth: number, targetTokens: number, needleText: string, probe: string, filler: "repeat" | "varied" = "repeat"): AgentMessage[] {
	const probeTokens = estTokens(probe) + 10;
	const needleTurnTokens = estTokens(needleText) + 60;
	const paddingTokens = Math.max(0, targetTokens - needleTurnTokens - probeTokens);
	const beforeTokens = Math.floor(paddingTokens * depth);
	const afterTokens = paddingTokens - beforeTokens;

	const messages: AgentMessage[] = [];
	let turnIdx = 0;

	let beforeRemaining = beforeTokens;
	while (beforeRemaining > 80) {
		const resultTokens = Math.min(beforeRemaining - 60, TARGET_TURN_TOKENS);
		messages.push(...makeTurn(turnIdx++, Math.max(10, resultTokens), "before", filler));
		beforeRemaining -= resultTokens + 60;
	}

	messages.push(...makeNeedleTurn(turnIdx++, needleText));

	let afterRemaining = afterTokens;
	while (afterRemaining > 80) {
		const resultTokens = Math.min(afterRemaining - 60, TARGET_TURN_TOKENS);
		messages.push(...makeTurn(turnIdx++, Math.max(10, resultTokens), "after", filler));
		afterRemaining -= resultTokens + 60;
	}

	messages.push({ id: `u-probe`, role: "user", content: [{ type: "text", text: probe }] });
	return messages;
}

export function buildMultiKeyHaystack(targetTokens: number, probe: string, filler: "repeat" | "varied" = "repeat"): AgentMessage[] {
	const probeTokens = estTokens(probe) + 10;
	const needleTokens = MULTI_NEEDLES.reduce((s, n) => s + estTokens(n.text) + 60, 0);
	const paddingTokens = Math.max(0, targetTokens - needleTokens - probeTokens);

	const gaps = [
		Math.floor(paddingTokens * MULTI_NEEDLE_DEPTHS[0]),
		Math.floor(paddingTokens * (MULTI_NEEDLE_DEPTHS[1] - MULTI_NEEDLE_DEPTHS[0])),
		Math.floor(paddingTokens * (MULTI_NEEDLE_DEPTHS[2] - MULTI_NEEDLE_DEPTHS[1])),
		paddingTokens - Math.floor(paddingTokens * MULTI_NEEDLE_DEPTHS[2]),
	];

	const messages: AgentMessage[] = [];
	let turnIdx = 0;

	for (let g = 0; g < 4; g++) {
		let remaining = gaps[g];
		while (remaining > 80) {
			const resultTokens = Math.min(remaining - 60, TARGET_TURN_TOKENS);
			messages.push(...makeTurn(turnIdx++, Math.max(10, resultTokens), `gap${g}`, filler));
			remaining -= resultTokens + 60;
		}
		if (g < MULTI_NEEDLES.length) {
			messages.push(...makeNeedleTurn(turnIdx++, MULTI_NEEDLES[g].text));
		}
	}

	messages.push({ id: `u-probe`, role: "user", content: [{ type: "text", text: probe }] });
	return messages;
}

// ── Ollama integration ────────────────────────────────────────────────────────

function toOllamaMessages(messages: AgentMessage[]): OllamaMessage[] {
	const out: OllamaMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
	for (const msg of messages) {
		const role = (msg as any).role as string;
		const content = (msg as any).content;

		const getText = (c: unknown): string => {
			if (typeof c === "string") return c;
			if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n");
			return "";
		};

		if (role === "user") {
			out.push({ role: "user", content: getText(content) });
		} else if (role === "assistant") {
			const parts = Array.isArray(content) ? content : [];
			const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n");
			const toolCalls: OllamaToolCall[] = parts
				.filter((p: any) => p.type === "toolCall" || p.type === "tool_use")
				.map((p: any) => ({
					id: p.id,
					type: "function" as const,
					function: { name: p.name, arguments: JSON.stringify(p.arguments ?? p.input ?? {}) },
				}));
			const omsg: OllamaMessage = { role: "assistant", content: text || " " };
			if (toolCalls.length > 0) omsg.tool_calls = toolCalls;
			out.push(omsg);
		} else if (role === "toolResult") {
			out.push({ role: "tool", tool_call_id: (msg as any).toolCallId ?? "", content: getText(content) });
		}
	}
	return out;
}

async function callOllama(messages: OllamaMessage[], model: string, baseUrl: string, apiKey: string): Promise<string> {
	const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	const MAX_RETRIES = 12;
	let delay = 20_000;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 600_000);
		try {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 500, stream: false }),
				signal: controller.signal,
			});
			if (res.status === 429 || res.status === 503) {
				await res.text().catch(() => "");
				const retryAfter = res.headers.get("retry-after");
				const base = retryAfter ? Math.max(parseInt(retryAfter, 10) * 1000, delay) : delay;
				const jitter = Math.random() * 5_000;
				const wait = base + jitter;
				process.stderr.write(`    [rate-limit] 429 — waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})…\n`);
				await new Promise((r) => setTimeout(r, wait));
				delay = Math.min(delay * 1.5, 120_000);
				continue;
			}
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
			}
			const json = await res.json() as any;
			return json.choices?.[0]?.message?.content ?? "";
		} catch (e: any) {
			if (e.name === "AbortError") throw new Error(`Ollama request timed out after 600s`);
			throw e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`API still rate-limited after ${MAX_RETRIES} retries`);
}

async function pingApi(baseUrl: string, apiKey: string): Promise<void> {
	const url = `${baseUrl.replace(/\/$/, "")}/models`;
	const headers: Record<string, string> = {};
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
		if (!res.ok) throw new Error(`status ${res.status}`);
	} catch (e: any) {
		process.stderr.write(`[ERROR] API not reachable at ${baseUrl}: ${e.message}\n`);
		if (!apiKey) process.stderr.write(`        Tip: pass --api-key if this endpoint requires auth\n`);
		process.exit(1);
	}
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreAnswer(answer: string, keys: string[]): number {
	const lower = answer.toLowerCase();
	const hits = keys.filter((k) => lower.includes(k.toLowerCase())).length;
	return hits / keys.length;
}

async function answerScore(messages: AgentMessage[], keys: string[], cfg: Config): Promise<{ answer: string; score: number }> {
	if (cfg.offlineAnswer) {
		const answer = parseMessages(messages).blocks.map((block) => block.text).join("\n");
		return { answer, score: scoreAnswer(answer, keys) };
	}
	const answer = await callOllama(toOllamaMessages(messages), cfg.model, cfg.baseUrl, cfg.apiKey);
	return { answer, score: scoreAnswer(answer, keys) };
}

// ── Benchmark runner ──────────────────────────────────────────────────────────

async function runCell(cfg: Config, length: number, depth: number | null, budget: number, run: number): Promise<CellResult> {
	const isMulti = cfg.mode === "multi-key";
	const needleKeys = isMulti ? MULTI_NEEDLES.map((n) => n.key) : [NEEDLE_KEY];

	const probe = isMulti
		? (cfg.probe === "indirect" ? MULTI_PROBE_INDIRECT : cfg.probe === "realistic" ? MULTI_PROBE_REALISTIC : MULTI_PROBE_DIRECT)
		: (cfg.probe === "indirect" ? PROBE_INDIRECT : cfg.probe === "realistic" ? PROBE_REALISTIC : PROBE_DIRECT);

	const messages = isMulti
		? buildMultiKeyHaystack(length, probe, cfg.filler)
		: buildHaystack(depth!, length, NEEDLE, probe, cfg.filler);

	const inputTokens = tokensOfMessages(messages);
	const t0 = Date.now();

	// Baseline: raw messages → answer scorer.
	const baseline = await answerScore(messages, needleKeys, cfg);
	const baselineAnswer = baseline.answer;
	const baselineScore = baseline.score;

	if (cfg.verbose) {
		process.stderr.write(`    baseline answer: "${baselineAnswer.slice(0, 120)}"\n`);
	}

	let accordionScore = baselineScore;
	let needleFolded = false;
	let needleRescued = false;
	let falseUnfolds = 0;
	let foldedTokens = inputTokens;
	let foldDecisions = 0;

	if (budget < 1.0) {
		const budgetTokens = Math.max(100, Math.floor(inputTokens * budget));
		const deps: ConductorDependencies = cfg.summary
			? { summaryProvider: createOllamaSummaryProvider({ model: cfg.model, baseUrl: cfg.baseUrl }) }
			: {};
		if (cfg.localModel) {
			const artifact = loadModelArtifact(cfg);
			Object.assign(
				deps,
				artifact ? createArtifactConductorModelProviders(artifact, cfg.modelAuthority) : createLocalConductorModelProviders(),
				{ shadowMode: false },
			);
		}

		const state = createAccordionState();
		const { blocks } = parseMessages(messages);
		if (cfg.embeddings) {
			const embProvider = await createTransformersEmbeddingProvider();
			await warmEmbeddings(blocks, probe, embProvider, state);
		}
		if (cfg.localModel) {
			await warmConductorModel({ blocks, prompt: probe, messages, state, targetModelId: cfg.model }, deps);
		}

		// ── Diagnostic (--verbose): embedding path verification ───────────────────
		if (cfg.verbose) {
			const cacheSize = Object.keys(state.embeddingCache).length;
			process.stderr.write(`  [embed] active=${cfg.embeddings}  cache_vectors=${cacheSize}\n`);

			const allBlocks = blocks;
			const needleBlocks = allBlocks.filter(
				(b) => b.id.startsWith(NEEDLE_RESULT_ID_PREFIX) && b.kind === "tool_result",
			);
			const pv = state.embeddingCache[textHash(probe)];

			// Active relative-outlier settings (env vars override defaults)
			const activeMargin = parseFloat(process.env.ACCORDION_UNFOLD_MARGIN ?? "") || 0.08;
			const activeFloor = parseFloat(process.env.ACCORDION_UNFOLD_FLOOR ?? "") || (cacheSize > 0 ? 0.30 : UNFOLD_KEYWORD_THRESHOLD);

			for (const nb of needleBlocks) {
				const bv = state.embeddingCache[textHash(nb.text)];
				let relScore: number;
				let branch: string;
				if (bv && pv) {
					let dot = 0;
					for (let i = 0; i < bv.length; i++) dot += bv[i] * pv[i];
					relScore = dot;
					branch = "cosine";
				} else {
					relScore = keywordOverlap(nb.text, probe);
					branch = "keyword-fallback";
				}
				process.stderr.write(
					`  [needle ${nb.id}]  rel=${relScore.toFixed(4)}  branch=${branch}  floor=${activeFloor.toFixed(2)}  margin=${activeMargin.toFixed(2)}  (outlier vs median; clears floor=${relScore >= activeFloor ? "YES" : "NO"})\n`,
				);
			}

			// Filler cosine stats (only meaningful when embeddings are active)
			if (cfg.embeddings && cacheSize > 0 && pv) {
				const fillerBlocks = allBlocks.filter(
					(b) => !b.id.startsWith(NEEDLE_RESULT_ID_PREFIX) && b.kind === "tool_result",
				);
				const fillerSims: number[] = [];
				for (const fb of fillerBlocks) {
					const fv = state.embeddingCache[textHash(fb.text)];
					if (fv) {
						let dot = 0;
						for (let i = 0; i < fv.length; i++) dot += fv[i] * pv[i];
						fillerSims.push(dot);
					}
				}
				if (fillerSims.length > 0) {
					fillerSims.sort((a, b) => a - b);
					const median = fillerSims[Math.floor(fillerSims.length / 2)];
					const max = fillerSims[fillerSims.length - 1];
					process.stderr.write(
						`  [filler]  n=${fillerSims.length}  median=${median.toFixed(4)}  max=${max.toFixed(4)}\n`,
					);
				}
			}
		}
		// ─────────────────────────────────────────────────────────────────────────

		const output = runConductor(
			{ messages, incomingPrompt: probe, lastCompletedTurn: null, budgetTokens, state, workingTailTokens: cfg.workingTailTokens },
			deps,
		);

		// Check if the needle block was among the folded ones
		const foldedIds = new Set(output.decisions.filter((d) => d.action === "fold").map((d) => d.blockId));
		needleFolded = output.decisions.some(
			(d) => d.action === "fold" && d.blockId.startsWith(NEEDLE_RESULT_ID_PREFIX),
		);
		needleRescued = (output.proactiveUnfolds).some((id) => id.startsWith(NEEDLE_RESULT_ID_PREFIX));
		// Exclude the paired tool_call (a-needle-*) — it unfolds alongside its result; not a false positive.
		falseUnfolds = (output.proactiveUnfolds).filter(
			(id) => !id.startsWith(NEEDLE_RESULT_ID_PREFIX) && !id.startsWith(NEEDLE_TURN_ID_PREFIX),
		).length;

		foldedTokens = tokensOfMessages(output.messages);
		foldDecisions = foldedIds.size;

		if (cfg.verbose) {
			const needleDecisions = output.decisions.filter((d) => d.blockId.startsWith(NEEDLE_RESULT_ID_PREFIX));
			const outcome = needleFolded ? "FOLDED (digest only)" : needleDecisions.some((d) => d.action === "unfold") ? "UNFOLDED (proactive rescue)" : "full fidelity (never folded)";
			process.stderr.write(`  [needle outcome]  ${outcome}\n`);
		}

		const accordion = await answerScore(output.messages, needleKeys, cfg);
		const accordionAnswer = accordion.answer;
		accordionScore = accordion.score;

		if (cfg.verbose) {
			process.stderr.write(`    accordion answer: "${accordionAnswer.slice(0, 120)}" (needle folded: ${needleFolded})\n`);
		}
	}

	return {
		length,
		depth,
		budget,
		run,
		probe,
		baselineScore,
		accordionScore,
		needleFolded,
		needleRescued,
		falseUnfolds,
		inputTokens,
		foldedTokens,
		savedTokens: inputTokens - foldedTokens,
		effectiveFoldRatio: foldedTokens / Math.max(1, inputTokens),
		foldDecisions,
		durationMs: Date.now() - t0,
	};
}

// ── Output ────────────────────────────────────────────────────────────────────

function pct(n: number): string {
	return `${Math.round(n * 100)}%`.padStart(5);
}

function renderHeatmap(results: CellResult[], budget: number, cfg: Config): string {
	const isBaseline = budget === 1.0;
	const label = isBaseline ? "no fold (baseline)" : `fold to ~${Math.round(budget * 100)}% of budget`;
	const lines: string[] = [`\nBudget: ${budget} (${label})`];

	if (cfg.mode === "multi-key") {
		lines.push("Length    Baseline  Accordion  NeedleFolded%");
		for (const length of cfg.lengths) {
			const cells = results.filter((r) => r.length === length && r.budget === budget);
			if (cells.length === 0) continue;
			const base = cells.reduce((s, c) => s + c.baselineScore, 0) / cells.length;
			const acc = cells.reduce((s, c) => s + c.accordionScore, 0) / cells.length;
			const folded = cells.filter((c) => c.needleFolded).length / cells.length;
			const lbl = `${length >= 1000 ? length / 1000 + "k" : length}`.padEnd(8);
			lines.push(`${lbl}  ${pct(base)}     ${isBaseline ? " (same)" : pct(acc)}     ${isBaseline ? "    -" : pct(folded)}`);
		}
	} else {
		const colW = 7;
		// Two sub-tables: baseline and accordion scores side by side
		const header = "Depth \\ Length" + cfg.lengths.map((l) => `${l >= 1000 ? l / 1000 + "k" : l}`.padStart(colW)).join("");
		lines.push(header);
		for (const depth of cfg.depths) {
			const depthLabel = `${Math.round(depth * 100)}%`.padEnd(15);
			const row = depthLabel + cfg.lengths.map((length) => {
				const cells = results.filter((r) => r.length === length && r.depth === depth && r.budget === budget);
				if (cells.length === 0) return "   N/A".padStart(colW);
				const score = cells.reduce((s, c) => s + (isBaseline ? c.baselineScore : c.accordionScore), 0) / cells.length;
				const anyFolded = cells.some((c) => c.needleFolded);
				const mark = (!isBaseline && anyFolded) ? "*" : " ";
				return (pct(score) + mark).padStart(colW);
			}).join("");
			lines.push(row);
		}
		if (!isBaseline) lines.push("  * = needle block was folded for at least one run in this cell");
	}
	return lines.join("\n");
}

function renderSummaryTable(results: CellResult[], cfg: Config): string {
	const lines = ["\n── Accordion delta vs baseline (accordion − baseline) ──"];
	lines.push("Budget    " + cfg.lengths.map((l) => `${l >= 1000 ? l / 1000 + "k" : l}`.padStart(7)).join(""));
	for (const budget of cfg.budgets.filter((b) => b < 1.0)) {
		const row = `${budget}`.padEnd(10) + cfg.lengths.map((length) => {
			const base = results.filter((r) => r.length === length && r.budget === 1.0);
			const acc = results.filter((r) => r.length === length && r.budget === budget);
			if (!base.length || !acc.length) return "    N/A".padStart(7);
			const baseAvg = base.reduce((s, c) => s + c.baselineScore, 0) / base.length;
			const accAvg = acc.reduce((s, c) => s + c.accordionScore, 0) / acc.length;
			const delta = accAvg - baseAvg;
			const sign = delta > 0.01 ? "+" : delta < -0.01 ? "" : " ";
			return (sign + Math.round(delta * 100) + "pp").padStart(7);
		}).join("");
		lines.push(row);
	}
	return lines.join("\n");
}

function writeResults(results: CellResult[], cfg: Config): void {
	const grouped: Record<string, number[]> = {};
	for (const r of results) {
		(grouped[String(r.budget)] ??= []).push(r.accordionScore);
	}
	const summary: Record<string, number> = {};
	for (const [k, scores] of Object.entries(grouped)) {
		summary[`budget_${k}_mean_accuracy`] = scores.reduce((a, b) => a + b, 0) / scores.length;
	}

	// Needle fold / rescue / false-unfold rates per budget
	for (const budget of cfg.budgets.filter((b) => b < 1.0)) {
		const cells = results.filter((r) => r.budget === budget);
		const n = Math.max(1, cells.length);
		summary[`budget_${budget}_needle_fold_rate`] = cells.filter((c) => c.needleFolded).length / n;
		summary[`budget_${budget}_needle_rescue_rate`] = cells.filter((c) => c.needleRescued).length / n;
		summary[`budget_${budget}_false_unfold_rate`] = cells.reduce((s, c) => s + c.falseUnfolds, 0) / n;
	}

	const probeNote = cfg.probe === "direct"
		? "probe shares keywords with needle; conductor may proactively unfold"
		: cfg.probe === "realistic"
		? "probe is semantically related but lexically isolated; Stage 2 (embeddings) is the only rescue path"
		: "probe has no keyword overlap with needle; conductor cannot rescue folded needle";
	const notes: string[] = [
		`probe mode: ${cfg.probe} — ${probeNote}`,
		`working tail protection: 20000 tokens — contexts smaller than ~20k may see 0 folds`,
		`fold_target_ratio: 0.8 — conductor folds to 80% of budget, not 100%`,
	];

	const out: BenchmarkResults = {
		meta: {
			date: new Date().toISOString(),
			model: cfg.model,
			baseUrl: cfg.baseUrl,
			mode: cfg.mode,
			probe: cfg.probe,
			runs: cfg.runs,
			embeddings: cfg.embeddings,
			modelArtifact: cfg.modelArtifactFile,
			modelAuthority: cfg.modelAuthorityFile,
			modelAuthorityImplicit: cfg.modelAuthorityImplicit,
			notes,
		},
		cells: results,
		summary,
	};
	writeFileSync(cfg.outFile, JSON.stringify(out, null, 2));
	process.stderr.write(`\nResults written to ${cfg.outFile}\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const cfg = parseCli(process.argv.slice(2));
	const authority = loadConductorModelAuthority({
		artifactFile: cfg.modelArtifactFile,
		authorityFile: cfg.modelAuthorityFile,
	});
	cfg.modelAuthority = authority.authority;
	cfg.modelAuthorityFile = authority.file;
	cfg.modelAuthorityImplicit = authority.implicit;

	// Lexical isolation assertion: runs at startup for "realistic" probe
	if (cfg.probe === "realistic") {
		const needleTexts = cfg.mode === "multi-key" ? MULTI_NEEDLES.map((n) => n.text) : [NEEDLE];
		const probeStr = cfg.mode === "multi-key" ? MULTI_PROBE_REALISTIC : PROBE_REALISTIC;
		assertLexicalIsolation(probeStr, needleTexts);
	}

	process.stderr.write(`NIAH Benchmark\n`);
	process.stderr.write(`  model:     ${cfg.model} @ ${cfg.baseUrl}${cfg.apiKey ? " (auth ✓)" : ""}\n`);
	process.stderr.write(`  mode:      ${cfg.mode}\n`);
	process.stderr.write(`  probe:     ${cfg.probe}\n`);
	process.stderr.write(`  filler:    ${cfg.filler}\n`);
	process.stderr.write(`  lengths:   ${cfg.lengths.join(", ")}\n`);
	if (cfg.mode === "single") process.stderr.write(`  depths:    ${cfg.depths.join(", ")}\n`);
	process.stderr.write(`  budgets:   ${cfg.budgets.join(", ")}\n`);
	process.stderr.write(`  runs:      ${cfg.runs}\n`);
	process.stderr.write(`  summaries: ${cfg.summary ? "ollama" : "deterministic"}\n`);
	process.stderr.write(`  localModel: ${cfg.localModel ? "on" : "off"}\n`);
	process.stderr.write(`  answer:    ${cfg.offlineAnswer ? "offline-key-presence" : "model"}\n`);
	if (cfg.workingTailTokens !== undefined) process.stderr.write(`  tail:      ${cfg.workingTailTokens} tokens\n`);
	if (cfg.modelArtifactFile) process.stderr.write(`  artifact:  ${cfg.modelArtifactFile}\n`);
	if (cfg.modelAuthorityFile) process.stderr.write(`  authority: ${cfg.modelAuthorityFile}${cfg.modelAuthorityImplicit ? " (sidecar)" : ""}\n`);
	process.stderr.write("\n");

	if (!cfg.offlineAnswer) await pingApi(cfg.baseUrl, cfg.apiKey);

	const cells: Array<[number, number | null, number, number]> = [];
	if (cfg.mode === "multi-key") {
		for (const length of cfg.lengths)
			for (const budget of cfg.budgets)
				for (let run = 0; run < cfg.runs; run++)
					cells.push([length, null, budget, run]);
	} else {
		for (const length of cfg.lengths)
			for (const depth of cfg.depths)
				for (const budget of cfg.budgets)
					for (let run = 0; run < cfg.runs; run++)
						cells.push([length, depth, budget, run]);
	}

	const total = cells.length;
	const results: CellResult[] = [];

	for (let i = 0; i < cells.length; i++) {
		const [length, depth, budget, run] = cells[i];
		const result = await runCell(cfg, length, depth, budget, run);
		results.push(result);

		const arrow = result.accordionScore >= 1 ? "✓" : result.accordionScore > 0 ? "~" : "✗";
		const depthLabel = depth !== null ? ` depth=${depth}` : "";
		const savedLabel = budget < 1.0
			? ` (saved ${result.savedTokens}tok/${result.inputTokens}tok=${Math.round((1 - result.effectiveFoldRatio) * 100)}%, ${result.foldDecisions} folds${result.needleFolded ? ", NEEDLE FOLDED" : ""})`
			: " (baseline)";
		const deltaLabel = budget < 1.0 && result.accordionScore !== result.baselineScore
			? ` [base=${Math.round(result.baselineScore * 100)}%]`
			: "";
		process.stderr.write(`[${i + 1}/${total}] len=${length}${depthLabel} budget=${budget} run=${run} → ${arrow}${deltaLabel}${savedLabel}\n`);
	}

	writeResults(results, cfg);

	for (const budget of cfg.budgets) {
		process.stdout.write(renderHeatmap(results, budget, cfg) + "\n");
	}
	if (cfg.mode === "single") {
		process.stdout.write(renderSummaryTable(results, cfg) + "\n");
	}
}

// Guard: only run as entrypoint, not when imported by sweep-unfold.ts
if (process.argv[1]?.endsWith("benchmark-niah.ts") || process.argv[1]?.endsWith("benchmark-niah")) {
	await main();
}
