/**
 * Accordion Context Extension
 * ===========================
 * The Conductor decides what to fold each turn and rewrites the outgoing pi
 * context. Originals stay in the session log; folding only changes the assembled
 * view sent to the model for THIS call.
 *
 * The Accordion desktop GUI attaches over a per-session WebSocket (ephemeral
 * loopback port, advertised in ~/.accordion/sessions/<id>.json) and MIRRORS the
 * Conductor's decisions — it does not compute its own fold plan. User actions in
 * the GUI flow back as `userAction` messages and mutate AccordionState
 * immediately; the Conductor sees them on its next context hook.
 *
 * Four actors with VISION.md permissions: user (you, GUI + cmd) can fold /
 * unfold / pin / peek; agent can unfold / pin / recall; Conductor can fold /
 * unfold (never pin). Peek is GUI-only (purely UI; never touches state).
 *
 * Register in ~/.pi/agent/settings.json:
 *   { "extensions": ["<repo>/src/accordion.ts"] }
 */

import { writeFile } from "node:fs";
import { homedir } from "node:os";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AGENT_TOOL_DEFS, agentPin, agentRecall, agentUnfold, foldBlocks, pinBlocks, unfoldBlocks, unpinBlocks } from "./agent-tools.ts";
import { ACCORDION_AGENT_SKILL } from "./accordion-skill.ts";
import {
	applyDecisionsToState,
	contentHash,
	createAccordionState,
	createGeminiSummaryProvider,
	createHaikuSummaryProvider,
	createOllamaSummaryProvider,
	createTransformersEmbeddingProvider,
	mergeConductorConfig,
	pruneEmbeddingCache,
	warmEmbeddings,
	blockTokensAtLevel,
	deterministicDigest,
	foldAddress,
	trimmedText,
	groupMemberText,
	extractIncomingPrompt,
	lastCompletedTurnFromMessages,
	parseMessages,
	runConductor,
	type AccordionGroup,
	type AccordionState,
	type ConductorConfig,
	type ContextBlock,
	type FoldDecision,
	type FoldLevel,
	type SummaryProvider,
} from "./conductor.ts";
import { linearize, blockId, type PiMessage } from "../app/src/lib/live/mapping.ts";
import {
	DISCOVERY_PORT,
	PROTOCOL_VERSION,
	type ServerMessage,
	type StreamMessage,
	type UserActionMessage,
	type WireGroup,
} from "../app/src/lib/live/protocol.ts";
import {
	REGISTRY_DIR,
	SESSIONS_SUBDIR,
	FOCUS_FILE,
	HEARTBEAT_INTERVAL_MS,
	type SessionEntry,
	type FocusRequest,
} from "../app/src/lib/live/registry.ts";

// ── Constants ────────────────────────────────────────────────────────────────

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

// Registry layout — the GUI desktop discovery contract.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);
const ACCORDION_APP_FLAG = "accordion-app";
const ACCORDION_APP_ENV = "ACCORDION_APP_PATH";

type TextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, never>;
};

// ── Summary / embedding providers ────────────────────────────────────────────

function effectiveSummariesEnabled(config: ConductorConfig): boolean {
	return config.summariesEnabled && ENV_SUMMARIES_ENABLED;
}

function effectiveEmbeddingsEnabled(config: ConductorConfig): boolean {
	return config.embeddingsEnabled || ENV_EMBEDDINGS_ENABLED;
}

/** Default Ollama; prefer Gemini when GOOGLE_API_KEY is set. */
function useOllamaSummary(config: ConductorConfig): boolean {
	const env = process.env.ACCORDION_OLLAMA;
	if (env === "0" || env === "false") return false;
	if (env === "1" || env === "true") return true;
	if (process.env.GOOGLE_API_KEY && !config.summaryModel.trim()) return false;
	const m = config.summaryModel.trim().toLowerCase();
	if (!m || m === config.ollamaModel.trim().toLowerCase()) return true;
	if (m.includes("claude") || m.includes("haiku") || m.includes("gemini")) return false;
	return true;
}

function buildSummaryProvider(config: ConductorConfig): SummaryProvider | undefined {
	if (!effectiveSummariesEnabled(config)) return undefined;
	let base: SummaryProvider | undefined;
	if (useOllamaSummary(config)) {
		base = createOllamaSummaryProvider({
			baseUrl: config.ollamaBaseUrl,
			model: config.ollamaModel,
			timeoutMs: config.summaryTimeoutMs,
		});
	} else {
		base = createHaikuSummaryProvider(process.env.ANTHROPIC_API_KEY, config.summaryModel) ?? createGeminiSummaryProvider(process.env.GOOGLE_API_KEY);
	}
	if (!base) return undefined;
	return async (input) => {
		try {
			const result = await base!(input);
			if (result.startsWith("Summary:")) state.providerError = undefined;
			return result;
		} catch (error: any) {
			state.providerError = `Summary: ${error?.message || error}`.slice(0, 200);
			throw error;
		}
	};
}

function syncProviderErrorFromState(): void {
	if (state.missingApiKeyLogged && !state.providerError) {
		state.providerError = "ANTHROPIC_API_KEY missing; using digests";
	}
}

// ── Module-level state ───────────────────────────────────────────────────────

let state: AccordionState = createAccordionState();
let lastKnownMessages: AgentMessage[] = [];
let summaryProvider = buildSummaryProvider(state.config);
let embeddingProvider: any = null;
let embeddingProviderInitAttempted = false;
let lastEmbeddingModel = state.config.embeddingModel;

// ── JSONL live snapshot (for the old file-based desktop preview) ─────────────

function writeLiveSnapshot(ctx: ExtensionContext): void {
	try {
		const branch = ctx.sessionManager.getBranch() as any[];
		const allEntries = branch.filter((e: any) =>
			e.type === "session" || e.type === "message" || e.type === "compaction" ||
			(e.type === "custom" && e.customType === CONDUCTOR_DECISION_TYPE),
		);
		const relevant = allEntries.filter((e: any) => e.type !== "custom" || e.customType !== CONDUCTOR_DECISION_TYPE);
		const decisions = allEntries.filter((e: any) => e.type === "custom" && e.customType === CONDUCTOR_DECISION_TYPE).slice(-20);

		if (!relevant.some((e: any) => e.type === "session")) {
			relevant.unshift({ type: "session", version: 3, cwd: "", timestamp: new Date().toISOString() });
		}

		const foldedSet = new Set(state.foldedBlockIds);
		const foldedSummaries: Record<string, string> = {};
		if (foldedSet.size > 0 && Object.keys(state.summaryCache).length > 0) {
			try {
				const messages = branch.filter((e: any) => e.type === "message").map((e: any) => e.message).filter(Boolean);
				const parsed = parseMessages(messages);
				for (const block of parsed.blocks) {
					if (!foldedSet.has(block.id)) continue;
					const hash = contentHash(block);
					const summary = state.summaryCache[hash];
					if (summary) foldedSummaries[block.id] = summary;
				}
			} catch { /* tolerate parse errors */ }
		}

		relevant.push({
			type: "custom",
			customType: CONDUCTOR_STATE_TYPE,
			data: {
				foldTargetCalibrated: state.foldTargetCalibrated,
				config: state.config,
				missingApiKeyLogged: state.missingApiKeyLogged,
				providerError: state.providerError,
				foldedBlockIds: state.foldedBlockIds,
				foldLevels: state.foldLevels,
				foldedSummaries,
				calibrationEvents: state.calibrationEvents.slice(-10),
			},
		});

		const all = [...relevant, ...decisions];
		const lines = all.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
		writeFile(LIVE_SNAPSHOT_PATH, lines, "utf8", () => {});
	} catch { /* best-effort */ }
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
		providerError: state.providerError,
		embeddingCache: state.embeddingCache,
		foldLevels: state.foldLevels,
		foldTargetCalibrated: state.foldTargetCalibrated,
		lastCalibrationTurn: state.lastCalibrationTurn,
		recentProactiveUnfoldTurns: state.recentProactiveUnfoldTurns,
		lastRunHadPressure: state.lastRunHadPressure,
		lastRunWithinBudget: state.lastRunWithinBudget,
		calibrationEvents: state.calibrationEvents,
		conductorPins: state.conductorPins,
		groups: state.groups,
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

// ── App launch helpers (focus/open the GUI desktop window) ───────────────────

type LaunchSource = "cli" | "env" | "default";
type LaunchResult =
	| { ok: true; path: string; source: LaunchSource }
	| { ok: false; reason: "explicit-invalid"; path: string; source: Extract<LaunchSource, "cli" | "env"> }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "spawn-failed"; path: string; source: LaunchSource; error: unknown };

function cleanExplicitPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let s = value.trim();
	if (!s) return null;
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
	return s;
}

function isLaunchableFile(p: string): boolean {
	try { return fs.statSync(p).isFile(); } catch { return false; }
}

function windowsInstallCandidates(): string[] {
	if (process.platform !== "win32") return [];
	const roots = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion"),
	].filter((s): s is string => !!s);
	const out: string[] = [];
	for (const root of roots) for (const name of ["Accordion.exe", "app.exe"]) out.push(path.join(root, name));
	return out;
}

function repoAppCandidates(): string[] {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const repo = path.resolve(here, "..");
		const ext = process.platform === "win32" ? ".exe" : "";
		return [
			path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
			path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`),
		];
	} catch { return []; }
}

function resolveAccordionApp(pi: ExtensionAPI): LaunchResult {
	const flagPath = cleanExplicitPath(pi.getFlag(ACCORDION_APP_FLAG));
	if (flagPath) {
		if (isLaunchableFile(flagPath)) return { ok: true, path: flagPath, source: "cli" };
		return { ok: false, reason: "explicit-invalid", path: flagPath, source: "cli" };
	}
	const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
	if (envPath) {
		if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
		return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
	}
	for (const candidate of [...windowsInstallCandidates(), ...repoAppCandidates()]) {
		if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
	}
	return { ok: false, reason: "not-found" };
}

async function launchAccordionApp(pi: ExtensionAPI): Promise<LaunchResult> {
	const resolved = resolveAccordionApp(pi);
	if (!resolved.ok) return resolved;
	try {
		const child = spawn(resolved.path, [], { detached: true, stdio: "ignore", shell: false });
		return await new Promise<LaunchResult>((resolve) => {
			let settled = false;
			const ok: LaunchResult = { ok: true, path: resolved.path, source: resolved.source };
			const timer = setTimeout(() => finish(ok), 150);
			const finish = (result: LaunchResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("spawn", onSpawn);
				child.unref();
				resolve(result);
			};
			const onSpawn = () => finish(ok);
			const onError = (error: unknown) => finish({ ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error });
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
	} catch (error) {
		return { ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error };
	}
}

function launchResultLine(result: LaunchResult | null): { text: string; type: "info" | "warning" } {
	if (!result) return { text: "Accordion focus requested for this session.", type: "info" };
	if (result.ok) return { text: "Launching/focusing Accordion for this session…", type: "info" };
	if (result.reason === "explicit-invalid") {
		const source = result.source === "cli" ? `--${ACCORDION_APP_FLAG}` : ACCORDION_APP_ENV;
		return { text: `Accordion focus request written, but ${source} does not point to an executable: ${result.path}`, type: "warning" };
	}
	if (result.reason === "spawn-failed") {
		return { text: `Accordion focus request written, but launching failed for ${result.path}. Set ${ACCORDION_APP_ENV} or --${ACCORDION_APP_FLAG} to the Accordion executable.`, type: "warning" };
	}
	return { text: `Accordion focus request written, but I couldn't find the desktop app. Open Accordion manually, or set ${ACCORDION_APP_ENV} / --${ACCORDION_APP_FLAG}.`, type: "warning" };
}

// ── HTTP discovery server ────────────────────────────────────────────────────
// One per process on a fixed loopback port. First pi process wins; others skip.
{
	const srv = http.createServer((req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		if (req.method === "GET" && req.url === "/sessions") {
			try {
				const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json") && !f.includes(".tmp"));
				const entries = files.flatMap(f => {
					try { return [JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"))]; }
					catch { return []; }
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(entries));
			} catch {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end("[]");
			}
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	srv.on("error", () => {}); // port busy — another pi instance already holds it
	srv.listen(DISCOVERY_PORT, "127.0.0.1");
	srv.unref();
}

// ── Main extension ───────────────────────────────────────────────────────────

export default function accordionExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ACCORDION_APP_FLAG, {
		description: "Path to the Accordion desktop app executable for /accordion launch/focus",
		type: "string",
	});

	// ── WebSocket server state ───────────────────────────────────────────────
	let wss: WebSocketServer | null = null;
	let client: WebSocket | null = null;
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", contextWindow: null as number | null, format: "pi" as const };

	let sentCount = 0;
	let reqSeq = 0;
	// Last messages snapshot seen at `context` or `agent_end`.
	let lastMessages: PiMessage[] = [];
	// Last parsed ContextBlocks — kept in sync with lastMessages so buildSnapshot
	// can always translate Conductor block ids → live-link ids even in view-only syncs.
	let lastParsedBlocks: ContextBlock[] = [];
	// Messages finished since the last `context`/`agent_end` snapshot.
	let pendingSince: PiMessage[] = [];
	// Most recent ctx captured from hooks (for flush on attach).
	let latestCtx: ExtensionContext | null = null;

	// Registry fields
	let port = 0;
	let startedAt = 0;
	let model = "";
	let tokens: number | null = null;
	let contextWindow: number | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const attached = (): boolean => !!client && client.readyState === 1;

	function send(ws: WebSocket, m: ServerMessage): void {
		try { ws.send(JSON.stringify(m)); } catch { /* socket gone */ }
	}

	function sendStream(frame: StreamMessage): void {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;
		send(ws, frame);
	}

	// ── Registry ─────────────────────────────────────────────────────────────

	function buildEntry(): SessionEntry {
		return {
			registryProtocol: 1,
			protocolVersion: PROTOCOL_VERSION,
			sessionId,
			port,
			pid: process.pid,
			cwd: meta.cwd,
			title: meta.title,
			model,
			tokens,
			contextWindow,
			startedAt,
			heartbeatAt: Date.now(),
		};
	}

	function writeEntry(): void {
		if (!port || !sessionId) return;
		try {
			fs.mkdirSync(SESSIONS_DIR, { recursive: true });
			const target = path.join(SESSIONS_DIR, `${sessionId}.json`);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(buildEntry()));
			fs.renameSync(tmp, target);
		} catch { /* best-effort */ }
	}

	function deleteEntry(): void {
		if (!sessionId) return;
		try { fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`)); } catch { /* already gone */ }
	}

	function writeFocusRequest(): void {
		if (!sessionId) return;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			const req: FocusRequest = { sessionId, ts: Date.now() };
			const tmp = `${FOCUS_PATH}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(req));
			fs.renameSync(tmp, FOCUS_PATH);
		} catch { /* best-effort */ }
	}

	function applyModel(m: { id?: string; contextWindow?: number } | undefined): void {
		if (!m) return;
		if (m.id) { model = m.id; meta.model = m.id; }
		if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
			contextWindow = m.contextWindow;
			meta.contextWindow = m.contextWindow;
		}
	}

	function refreshFromCtx(ctx: ExtensionContext): void {
		try {
			applyModel(ctx.model as { id?: string; contextWindow?: number } | undefined);
			const u = ctx.getContextUsage?.();
			if (u) {
				tokens = u.tokens;
				if (typeof u.contextWindow === "number") { contextWindow = u.contextWindow; meta.contextWindow = u.contextWindow; }
			}
		} catch { /* optional APIs */ }
	}

	// ── Build the authoritative sync snapshot ─────────────────────────────────

	/**
	 * The Conductor's block ids (e.g. `${messageId}:u`, `${messageId}:${ci}`) differ
	 * from the live-link's durable ids (`u:${timestamp}`, `a:${responseId}:p${j}`,
	 * `r:${toolCallId}`). Translate Conductor ids → live-link ids using each
	 * ContextBlock's `source` field (which records messageIndex and contentIndex) to
	 * call the same `blockId()` function the live-link uses. Unmapped ids are dropped.
	 */
	function conductorToLiveIds(conductorIds: string[], conductorBlocks: ContextBlock[]): string[] {
		const lookup = new Map<string, ContextBlock>();
		for (const b of conductorBlocks) lookup.set(b.id, b);
		const out: string[] = [];
		for (const cid of conductorIds) {
			const cb = lookup.get(cid);
			if (!cb) continue;
			const m = lastMessages[cb.source.messageIndex] as PiMessage | undefined;
			if (!m) continue;
			const liveId = blockId(m, cb.source.messageIndex, cb.source.contentIndex);
			out.push(liveId);
		}
		return out;
	}

	function buildSnapshot(conductorBlocks?: ContextBlock[]) {
		const blocks = conductorBlocks ?? lastParsedBlocks;
		const lookup = new Map<string, ContextBlock>();
		for (const b of blocks) lookup.set(b.id, b);

		const foldedBlockIds = blocks.length
			? conductorToLiveIds(state.foldedBlockIds, blocks)
			: state.foldedBlockIds;
		const pinnedBlockIds = blocks.length
			? conductorToLiveIds(state.pinnedBlockIds, blocks)
			: state.pinnedBlockIds;

		// Fold levels and digest texts — keyed by live-link id.
		const foldLevels: Record<string, 0 | 1 | 2 | 3> = {};
		const foldedDigests: Record<string, string> = {};

		for (const cid of state.foldedBlockIds) {
			const cb = lookup.get(cid);
			if (!cb) continue;
			const liveId = conductorToLiveIds([cid], blocks)[0];
			if (!liveId) continue;

			const level = (state.foldLevels[cid] ?? 2) as FoldLevel;
			foldLevels[liveId] = level;

			// Compute the exact text the agent sees. Use cached LLM summary if available.
			const hash = contentHash(cb);
			const cached = state.summaryCache[hash];
			let digestText: string;
			if (level === 1) {
				digestText = trimmedText(cb);
			} else if (level === 3) {
				digestText = groupMemberText(cb);
			} else {
				const body = cached || deterministicDigest(cb);
				digestText = foldAddress(cb) + body;
			}
			foldedDigests[liveId] = digestText;
		}

		return {
			foldedBlockIds,
			pinnedBlockIds,
			groups: state.groups as WireGroup[],
			foldLevels,
			foldedDigests,
		};
	}

	// ── Read session history directly from session manager ────────────────────

	function readSessionMessages(c: ExtensionContext | null): PiMessage[] {
		if (!c) return [];
		const sm = c.sessionManager as unknown as {
			buildSessionContext?: () => { messages?: unknown };
			getBranch?: (fromId?: string) => Array<{ type: string; message?: unknown }>;
		} | undefined;
		if (!sm) return [];
		try {
			const sc = sm.buildSessionContext?.();
			if (sc && Array.isArray(sc.messages)) return sc.messages as PiMessage[];
		} catch { /* fall through */ }
		try {
			const branch = sm.getBranch?.() ?? [];
			const msgs = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message as PiMessage);
			msgs.reverse();
			return msgs;
		} catch { return []; }
	}

	// ── Handle inbound user actions from the GUI ──────────────────────────────

	function handleUserAction(msg: UserActionMessage): void {
		const messages = lastKnownMessages;
		const decisions: FoldDecision[] = [];

		switch (msg.action) {
			case "fold":
				if (msg.blockId && messages.length) {
					const r = foldBlocks(messages, state, [msg.blockId], "you");
					decisions.push(...r);
				}
				break;
			case "unfold":
				if (msg.blockId && messages.length) {
					const r = unfoldBlocks(messages, state, [msg.blockId], "you");
					decisions.push(...r);
				}
				break;
			case "pin":
				if (msg.blockId && messages.length) {
					const r = pinBlocks(messages, state, [msg.blockId], "you");
					decisions.push(...r);
				}
				break;
			case "unpin":
				if (msg.blockId && messages.length) {
					const r = unpinBlocks(messages, state, [msg.blockId], "you");
					decisions.push(...r);
				}
				break;
			case "groupCreate": {
				if (!msg.startId || !msg.endId) break;
				const existingIds = new Set(state.groups.flatMap((g) => g.memberIds));
				// Resolve indices from linearized blocks
				const all = linearize(messages as PiMessage[]);
				const startIdx = all.findIndex((b) => b.id === msg.startId);
				const endIdx = all.findIndex((b) => b.id === msg.endId);
				if (startIdx < 0 || endIdx < 0) break;
				const lo = Math.min(startIdx, endIdx);
				const hi = Math.max(startIdx, endIdx);
				const memberIds = all.slice(lo, hi + 1).map((b) => b.id).filter((id) => !existingIds.has(id));
				if (memberIds.length < 2) break;
				const g: AccordionGroup = { id: `g:${memberIds[0]}`, memberIds, folded: true };
				state.groups = [...state.groups, g];
				break;
			}
			case "groupDelete": {
				if (!msg.groupId) break;
				state.groups = state.groups.filter((g) => g.id !== msg.groupId);
				break;
			}
			case "groupFold": {
				const g = state.groups.find((g) => g.id === msg.groupId);
				if (g) { g.folded = true; state.groups = [...state.groups]; }
				break;
			}
			case "groupUnfold": {
				const g = state.groups.find((g) => g.id === msg.groupId);
				if (g) { g.folded = false; state.groups = [...state.groups]; }
				break;
			}
		}

		if (decisions.length) persistDecisions(pi, decisions);
		persist(pi);
	}

	// ── WebSocket server ──────────────────────────────────────────────────────

	function startServer(): void {
		if (wss) return;
		try {
			wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
				const addr = wss?.address();
				if (addr && typeof addr === "object") {
					port = addr.port;
					writeEntry();
					if (!heartbeat) {
						heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);
						heartbeat.unref?.();
					}
				}
			});
		} catch {
			wss = null;
			return;
		}

		wss.on("connection", (ws: WebSocket) => {
			client = ws;
			sentCount = 0;
			reqSeq = 0;
			send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, meta });

			// Flush existing history on attach — critical for resumed/loaded sessions.
			const live = readSessionMessages(latestCtx);
			if (live.length) lastMessages = live;
			const backlog = linearize(lastMessages);
			const snap = buildSnapshot();
			if (backlog.length) {
				send(ws, {
					type: "sync",
					reqId: ++reqSeq,
					full: true,
					blocks: backlog,
					contextWindow,
					...snap,
					decisions: [],
				});
				sentCount = backlog.length;
			}

			ws.on("message", (data: Buffer) => {
				if (ws !== client) return;
				let msg: any;
				try { msg = JSON.parse(data.toString()); } catch { return; }
				if (msg?.type === "userAction") {
					handleUserAction(msg as UserActionMessage);
					// Push updated snapshot back so the GUI sees the result immediately.
					const updatedSnap = buildSnapshot();
					send(ws, {
						type: "sync",
						reqId: ++reqSeq,
						full: false,
						blocks: [],
						contextWindow,
						...updatedSnap,
						decisions: [],
					});
				}
			});

			const drop = () => { if (client === ws) client = null; };
			ws.on("close", drop);
			ws.on("error", drop);
		});

		wss.on("error", () => { wss = null; });
	}

	// Send a view-only sync (no decisions, just block deltas + current snapshot).
	function pushViewSync(): void {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;
		const all = linearize([...lastMessages, ...pendingSince]);
		if (all.length <= sentCount) return;
		const snap = buildSnapshot();
		send(ws, {
			type: "sync",
			reqId: ++reqSeq,
			full: sentCount === 0,
			blocks: all.slice(sentCount),
			contextWindow,
			...snap,
			decisions: [],
		});
		sentCount = all.length;
	}

	// ── Lifecycle hooks ───────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		restoreState(ctx);
		sessionId = `s-${process.pid}-${Date.now()}`;
		sentCount = 0;
		pendingSince = [];
		lastMessages = readSessionMessages(ctx);
		startedAt = Date.now();
		try { meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", contextWindow: null, format: "pi" }; }
		catch { /* keep defaults */ }
		refreshFromCtx(ctx);
		startServer();
		try { ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion")); }
		catch { /* status API optional */ }
		writeLiveSnapshot(ctx);
	});

	pi.on("message_update", (event: any) => {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;
		const ev = event?.assistantMessageEvent;
		if (!ev || typeof ev.type !== "string") return;
		const t = ev.type as string;
		const ci: number = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
		if (t === "text_start") sendStream({ type: "stream", phase: "start", kind: "text", contentIndex: ci });
		else if (t === "thinking_start") sendStream({ type: "stream", phase: "start", kind: "thinking", contentIndex: ci });
		else if (t === "toolcall_start") sendStream({ type: "stream", phase: "start", kind: "tool_call", contentIndex: ci });
		else if (t === "text_end") sendStream({ type: "stream", phase: "end", kind: "text", contentIndex: ci });
		else if (t === "thinking_end") sendStream({ type: "stream", phase: "end", kind: "thinking", contentIndex: ci });
		else if (t === "toolcall_end") sendStream({ type: "stream", phase: "end", kind: "tool_call", contentIndex: ci });
		else if (t === "error" || t === "aborted") sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
	});

	pi.on("context", async (event, ctx) => {
		latestCtx = ctx;
		refreshFromCtx(ctx);
		lastMessages = event.messages as unknown as PiMessage[];
		pendingSince = [];

		const before = JSON.stringify(state);
		const incomingPrompt = extractIncomingPrompt(event.messages);
		const parsed = parseMessages(event.messages);
		lastParsedBlocks = parsed.blocks; // keep translation map current

		try {
			await ensureEmbeddingProvider(state.config);
		} catch (error: any) {
			state.providerError = `Embeddings: ${error?.message || error}`.slice(0, 200);
			ctx.ui.notify(error.message, "warning");
		}

		if (effectiveEmbeddingsEnabled(state.config) && embeddingProvider) {
			try {
				await warmEmbeddings(parsed.blocks, incomingPrompt, embeddingProvider, state);
			} catch (error: any) {
				state.providerError = `Embeddings: ${error?.message || error}`.slice(0, 200);
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
		for (const warning of output.warnings) {
			// Embedding-missing is a routine degradation (warm-up not complete yet) — show
			// as info rather than warning to avoid alarming the user every turn.
			const level = warning.includes("prompt vector") ? "info" : "warning";
			ctx.ui.notify(warning, level);
		}
		syncProviderErrorFromState();
		if (before !== JSON.stringify(state)) persist(pi, parsed.blocks, incomingPrompt);
		writeLiveSnapshot(ctx);

		// Push authoritative sync to the GUI — new blocks + full Conductor snapshot.
		// Pass parsed.blocks so foldedBlockIds/pinnedBlockIds are translated from
		// Conductor ids (${messageId}:${ci}) to live-link ids (u:…/a:…/r:…).
		if (attached()) {
			const all = linearize(lastMessages);
			const fresh = all.slice(sentCount);
			const snap = buildSnapshot(parsed.blocks);
			const wireDecs = output.decisions.map((d): import("../app/src/lib/live/protocol.ts").WireFoldDecision => ({
				blockId: d.blockId,
				action: d.action as any,
				actor: d.actor as any,
				reason: d.reason,
				turn: d.turn,
				kind: d.kind as any,
				callId: d.callId,
				level: d.level,
				fromLevel: d.fromLevel,
			}));
			send(client!, {
				type: "sync",
				reqId: ++reqSeq,
				full: sentCount === 0,
				blocks: fresh,
				contextWindow,
				...snap,
				decisions: wireDecs,
			});
			sentCount = all.length;
		}

		// Inject skill when blocks are folded so the agent knows how to reach back.
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

	pi.on("model_select", (event) => {
		applyModel(event?.model as { id?: string; contextWindow?: number } | undefined);
		if (attached()) {
			const snap = buildSnapshot();
			send(client!, { type: "sync", reqId: ++reqSeq, full: false, blocks: [], contextWindow, ...snap, decisions: [] });
		}
	});

	pi.on("message_end", (event) => {
		const ws = client;
		if (!ws || ws.readyState !== 1) return;

		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });

		const msg = event.message as unknown as PiMessage;
		const msgIds = new Set(linearize([msg]).map((b) => b.id));
		const baseIds = new Set(linearize(lastMessages).map((b) => b.id));
		const pendIds = new Set(linearize(pendingSince).map((b) => b.id));
		const alreadySeen = [...msgIds].some((id) => baseIds.has(id) || pendIds.has(id));
		if (msgIds.size > 0 && !alreadySeen) pendingSince.push(msg);

		pushViewSync();
	});

	pi.on("agent_end", (event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		lastMessages = event.messages as unknown as PiMessage[];
		pendingSince = [];

		const ws = client;
		if (!ws || ws.readyState !== 1) return;

		sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
		pushViewSync();
	});

	/** Run the Conductor fold pass directly, used by both session_before_compact and /accordion. */
	async function runCompact(messages: AgentMessage[], ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		const parsed = parseMessages(messages);
		lastParsedBlocks = parsed.blocks; // keep translation map current
		const incomingPrompt = extractIncomingPrompt(messages);
		const beforeCount = state.foldedBlockIds.length;

		if (effectiveEmbeddingsEnabled(state.config) && embeddingProvider) {
			try {
				await warmEmbeddings(parsed.blocks, incomingPrompt, embeddingProvider, state);
			} catch { /* non-fatal */ }
		}

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
				log: (msg) => (ctx as ExtensionContext).ui?.notify(msg, "info"),
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
		(ctx as ExtensionContext).ui?.notify(
			`Accordion: ${state.foldedBlockIds.length} blocks folded${newFolds > 0 ? ` (+${newFolds} new)` : ""} · live ~${liveTok.toLocaleString()} tok`,
			"info",
		);

		writeLiveSnapshot(ctx as ExtensionContext);

		// Push the updated fold state to the GUI immediately — otherwise the tiles
		// only update at the next `context` hook (the next model call).
		if (attached()) {
			const all = linearize(lastMessages);
			const snap = buildSnapshot(parsed.blocks);
			send(client!, {
				type: "sync",
				reqId: ++reqSeq,
				full: false,
				blocks: [], // no new blocks — just a state update
				contextWindow,
				...snap,
				decisions: [],
			});
		}
	}

	pi.on("session_before_compact", async (_event, ctx) => {
		await runCompact(liveMessages(ctx), ctx);
		return { cancel: true };
	});

	pi.on("session_shutdown", () => {
		if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
		deleteEntry();
		try { client?.close(); } catch { /* ignore */ }
		try { wss?.close(); } catch { /* ignore */ }
		wss = null;
		client = null;
	});

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("accordion", {
		description: "Trigger Accordion context folding; /accordion status for a turn-by-turn report; /accordion focus to open the GUI",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim();
			if (arg === "status") {
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
			if (arg === "focus") {
				writeFocusRequest();
				const wasAttached = attached();
				const launch = wasAttached ? null : await launchAccordionApp(pi);
				const action = launchResultLine(launch);
				ctx.ui.notify(
					`${action.text}\nLive link: ${wasAttached ? "attached" : "detached"} · port ${port || "starting"} · streamed ${sentCount} blocks`,
					action.type,
				);
				return;
			}
			// Default: run the Conductor fold pass directly (no pi compact flow →
			// no "Compaction cancelled" error; Accordion owns the folding entirely).
			await runCompact(liveMessages(ctx), ctx);
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
				ctx.ui.notify("Usage: /expand <turn#>  (see /accordion status for numbers)", "warning");
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
			// Human-invoked fold via command — uses foldBlocks directly.
			const messages = liveMessages(ctx);
			const parsed = parseMessages(messages);
			const turns = args.trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
			if (!turns.length) {
				ctx.ui.notify("Usage: /fold <turn#>  — e.g. /fold 7", "warning");
				return;
			}
			const maxTurn = parsed.turns.at(-1)?.index ?? 0;
			const validTurns = turns.filter((t) => t >= 1 && t < maxTurn && parsed.turns.some((pt) => pt.index === t));
			if (!validTurns.length) {
				ctx.ui.notify(`No foldable turns in "${args.trim()}". Current turn (${maxTurn}) can't be folded.`, "warning");
				return;
			}
			const blockIds = parsed.blocks.filter((b) => validTurns.includes(b.turn)).map((b) => b.id);
			const changes = foldBlocks(messages, state, blockIds, "you");
			if (changes.length) persistDecisions(pi, changes);
			persist(pi, parsed.blocks);
			writeLiveSnapshot(ctx);
			ctx.ui.notify(`Folded ${changes.length} block${changes.length === 1 ? "" : "s"} across turn${validTurns.length === 1 ? "" : "s"} ${validTurns.join(", ")}.`, "info");
		},
	});

	pi.registerCommand("peek", {
		description: "Read a folded turn in full without changing the agent's context: /peek <turn#>",
		getArgumentCompletions: turnCompletions,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const result = agentRecall(liveMessages(ctx), state, args.trim(), 4_000);
			if (!result.ok) {
				ctx.ui.notify(`Usage: /peek <turn#>  — ${result.message}`, "warning");
				return;
			}
			ctx.ui.notify(result.content, "info");
		},
	});

	pi.registerCommand("conductor-config", {
		description: "Show or update Conductor runtime config (debug): /conductor-config [json]",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			let raw = args.trim();
			if (!raw) {
				pi.notify?.(JSON.stringify(state.config, null, 2), "info");
				return;
			}
			if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
				raw = raw.slice(1, -1);
			}
			try {
				const patch = JSON.parse(raw) as Partial<ConductorConfig>;
				state.config = mergeConductorConfig({ ...state.config, ...patch });
				resetProviders();
				persist(pi);
				pi.notify?.("Conductor config updated — takes effect on the next message.", "info");
			} catch (error) {
				pi.notify?.(`Invalid config JSON: ${String(error)}`, "warning");
			}
		},
	});

	// ── Skill discovery ───────────────────────────────────────────────────────

	pi.on("resources_discover", () => {
		try {
			const here = path.dirname(fileURLToPath(import.meta.url));
			const skillDir = path.join(here, "..", "skills", "accordion");
			if (fs.existsSync(skillDir)) return { skillPaths: [skillDir] };
		} catch { /* best-effort */ }
		return {};
	});

	registerAgentTools(pi);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
 * Register model-callable tools when the host pi build supports extension tools.
 * Permissions: agent can recall (read-only), unfold (restore), pin (protect).
 * Agent CANNOT fold — only you and the Conductor fold (VISION.md table).
 */
export function registerAgentTools(pi: ExtensionAPI): void {
	const register = (pi as any).registerTool;
	if (typeof register !== "function") return;

	const messagesFrom = (ctx: any): AgentMessage[] => {
		try {
			if (ctx?.sessionManager?.getBranch) return liveMessages(ctx);
		} catch {}
		return lastKnownMessages;
	};
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
		const result = agentPin(messages, state, turns);
		if (result.changes.length) {
			persistDecisions(pi, result.changes);
			persist(pi, parseMessages(messages).blocks);
			if (ctx) writeLiveSnapshot(ctx);
		}
		return result.message;
	});
}
