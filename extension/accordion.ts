/*
 * accordion.ts — the pi extension half of the Accordion live link.
 *
 * "GUI drives, extension is thin": this extension makes NO folding decisions. On
 * every `context` hook it linearizes pi's outgoing messages into blocks, streams
 * the new ones to the Accordion GUI over a WebSocket, awaits a fold plan, and
 * applies it to the messages pi is about to send. The GUI runs the engine.
 *
 * Connection model: "pull" (see docs/adr/0001-pi-live-integration.md). Each pi
 * session binds an EPHEMERAL loopback port and advertises itself by writing a
 * descriptor to ~/.accordion/sessions/<id>.json (see ../app/src/lib/live/registry).
 * The app watches that directory, lists every live session, and connects to the
 * one the user picks. `/accordion` writes a one-shot focus request so the app
 * foregrounds itself on this session. The extension never launches the app.
 *
 * Safety:
 *   • No GUI connected, or the plan reply times out → pass messages through
 *     UNMODIFIED. We never corrupt context.
 *   • pi's native /compact is suppressed ONLY while the GUI is attached.
 *   • The shared mapping (linearize/applyPlan) carries the provider-safety rules
 *     and a coarse "never fold the newest messages" backstop.
 *
 * Milestone 1: the GUI replies with an empty plan, so this never alters a model
 * call — it only proves the loop and powers the live view.
 *
 * Register it in ~/.pi/agent/settings.json:
 *   { "extensions": ["<repo>/extension/accordion.ts"] }
 */
import { WebSocketServer, type WebSocket } from "ws";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { linearize, applyPlan, type PiMessage } from "../app/src/lib/live/mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, type FoldOp, type ServerMessage } from "../app/src/lib/live/protocol";
import {
	REGISTRY_PROTOCOL,
	REGISTRY_DIR,
	SESSIONS_SUBDIR,
	FOCUS_FILE,
	HEARTBEAT_INTERVAL_MS,
	type SessionEntry,
	type FocusRequest,
} from "../app/src/lib/live/registry";

const REQUEST_TIMEOUT_MS = 250; // how long pi waits on the GUI before passing through

// Base dir is overridable for tests (smoke.mjs) so they don't touch the real home.
const HOME = process.env.ACCORDION_HOME || os.homedir();
const REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
const SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
const FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);

export default function accordionLive(pi: ExtensionAPI): void {
	let wss: WebSocketServer | null = null;
	let client: WebSocket | null = null; // the GUI (one driver at a time in M1)
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", format: "pi" as const };

	let sentCount = 0; // blocks already streamed to the current client
	let reqSeq = 0;
	let epoch = 0; // bumped on every new GUI connection; invalidates in-flight requests
	const pending = new Map<number, (ops: FoldOp[]) => void>();

	// ── discovery (registry) state ──────────────────────────────────────────────
	let port = 0; // actual ephemeral port, filled once the server is listening
	let startedAt = 0;
	let model = "";
	let tokens: number | null = null;
	let contextWindow: number | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const attached = (): boolean => !!client && client.readyState === 1; /* OPEN */

	/** Resolve every outstanding request as passthrough (used on connect-swap / shutdown). */
	function flushPending(): void {
		for (const resolve of pending.values()) resolve([]);
		pending.clear();
	}

	function send(ws: WebSocket, m: ServerMessage): void {
		try {
			ws.send(JSON.stringify(m));
		} catch {
			/* socket gone */
		}
	}

	// ── registry file: advertise this session for the app to discover ───────────
	function buildEntry(): SessionEntry {
		return {
			registryProtocol: REGISTRY_PROTOCOL,
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

	/** Atomic write (temp + rename) so the app never reads a half-written file. */
	function writeEntry(): void {
		if (!port || !sessionId) return;
		try {
			fs.mkdirSync(SESSIONS_DIR, { recursive: true });
			const target = path.join(SESSIONS_DIR, `${sessionId}.json`);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(buildEntry()));
			fs.renameSync(tmp, target);
		} catch {
			/* discovery is best-effort; never let it break a session */
		}
	}

	function deleteEntry(): void {
		if (!sessionId) return;
		try {
			fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
		} catch {
			/* already gone */
		}
	}

	/** /accordion writes a one-shot request for the (already-open) app to focus us. */
	function writeFocusRequest(): void {
		if (!sessionId) return;
		try {
			fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
			const req: FocusRequest = { sessionId, ts: Date.now() };
			const tmp = `${FOCUS_PATH}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(req));
			fs.renameSync(tmp, FOCUS_PATH);
		} catch {
			/* best-effort */
		}
	}

	/** Pull model id + live usage off the hook context (best-effort). */
	function refreshFromCtx(ctx: ExtensionContext): void {
		try {
			const m = ctx.getModel?.();
			if (m?.id) {
				model = m.id;
				meta.model = m.id;
				if (typeof m.contextWindow === "number") contextWindow = m.contextWindow;
			}
			const u = ctx.getContextUsage?.();
			if (u) {
				tokens = u.tokens;
				if (typeof u.contextWindow === "number") contextWindow = u.contextWindow;
			}
		} catch {
			/* optional APIs */
		}
	}

	function startServer(): void {
		if (wss) return;
		try {
			// port 0 ⇒ OS assigns a free ephemeral port (one server per pi session).
			wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
				const addr = wss?.address();
				if (addr && typeof addr === "object") {
					port = addr.port;
					writeEntry(); // advertise immediately, now that the port is known
					if (!heartbeat) {
						heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);
						heartbeat.unref?.(); // never keep the process alive for a heartbeat
					}
				}
			});
		} catch {
			wss = null;
			return;
		}
		wss.on("connection", (ws: WebSocket) => {
			flushPending(); // supersede any prior GUI: its in-flight requests pass through
			client = ws;
			epoch++;
			sentCount = 0; // re-sync the whole context to the freshly-connected GUI
			reqSeq = 0;
			send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, meta });
			ws.on("message", (data: Buffer) => {
				if (ws !== client) return; // ignore stray messages from a superseded GUI
				let msg: any;
				try {
					msg = JSON.parse(data.toString());
				} catch {
					return;
				}
				if (msg?.type === "plan" && typeof msg.reqId === "number") {
					const resolve = pending.get(msg.reqId);
					if (resolve) {
						pending.delete(msg.reqId);
						resolve(Array.isArray(msg.ops) ? msg.ops : []);
					}
				}
			});
			const drop = () => {
				if (client === ws) client = null;
			};
			ws.on("close", drop);
			ws.on("error", drop);
		});
		wss.on("error", () => {
			/* e.g. unexpected bind failure — run headless (passthrough) */
			wss = null;
		});
	}

	/** Send a sync and await the GUI's plan; resolves [] on timeout, null if unsent. */
	function requestPlan(reqId: number, full: boolean, blocks: ReturnType<typeof linearize>): Promise<FoldOp[] | null> {
		return new Promise((resolve) => {
			const ws = client;
			if (!ws || ws.readyState !== 1) return resolve(null);
			const timer = setTimeout(() => {
				if (pending.has(reqId)) {
					pending.delete(reqId);
					resolve([]); // delivered but no reply in time → passthrough
				}
			}, REQUEST_TIMEOUT_MS);
			pending.set(reqId, (ops) => {
				clearTimeout(timer);
				resolve(ops);
			});
			send(ws, { type: "sync", reqId, full, blocks });
		});
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		sessionId = `s-${process.pid}-${Date.now()}`;
		sentCount = 0;
		startedAt = Date.now();
		try {
			meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", format: "pi" };
		} catch {
			/* keep defaults */
		}
		refreshFromCtx(ctx); // model may be known already
		startServer();
		try {
			ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion"));
		} catch {
			/* status API optional */
		}
	});

	// ── the loop: stream context, await a plan, apply it ────────────────────────
	// Returning `undefined` keeps pi's original messages (documented passthrough);
	// only an explicit `{ messages }` replaces them. Every passthrough path below
	// returns undefined, so we never alter a model call without a plan.
	pi.on("context", async (event, ctx: ExtensionContext) => {
		const myEpoch = epoch;
		// Refresh model/usage in memory only — NO disk I/O on the model-call critical
		// path. The 5s heartbeat persists these to the registry for the sidebar.
		refreshFromCtx(ctx);
		const all = linearize(event.messages as unknown as PiMessage[]);
		if (!attached()) return; // no GUI → pass through untouched

		const fresh = all.slice(sentCount);
		const reqId = ++reqSeq;
		const full = sentCount === 0;
		const ops = await requestPlan(reqId, full, fresh);
		if (ops === null) return; // couldn't deliver → pass through, don't advance
		if (epoch !== myEpoch) return; // GUI reconnected mid-flight → don't apply/advance
		sentCount = all.length; // sync delivered → advance the stream cursor
		if (ops.length === 0) return; // empty plan (Milestone 1) → pass through

		return { messages: applyPlan(event.messages as unknown as PiMessage[], ops) as unknown as AgentMessage[] };
	});

	// ── suppress pi's native compaction ONLY while the GUI is driving ───────────
	pi.on("session_before_compact", (_event, ctx: ExtensionContext) => {
		if (attached()) {
			try {
				ctx.ui.notify("Accordion attached — native compaction suppressed.", "info");
			} catch {
				/* ignore */
			}
			return { cancel: true };
		}
		// detached → let pi protect itself
	});

	pi.on("session_shutdown", () => {
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		deleteEntry(); // stop advertising — the app drops our row immediately
		flushPending(); // resolve any awaiting context hook as passthrough
		try {
			client?.close();
		} catch {
			/* ignore */
		}
		try {
			wss?.close();
		} catch {
			/* ignore */
		}
		wss = null;
		client = null;
	});

	// ── /accordion : focus the app on this session + show status ────────────────
	pi.registerCommand("accordion", {
		description: "Focus the Accordion app on this pi session (and show live-link status)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			writeFocusRequest();
			const lines = [
				`Accordion live link — port ${port || "(starting)"}`,
				`GUI: ${attached() ? "ATTACHED — folding driven by the app" : "detached — passthrough, native /compact allowed"}`,
				`blocks streamed this connection: ${sentCount}`,
				`Asked the Accordion app to focus this session (open it if it isn't running).`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// DEFAULT_PORT is retained in protocol.ts only as the browser dev-loop fallback
// (the desktop app discovers ephemeral ports via the registry); reference it so
// the import graph and the constant's purpose stay explicit.
export const BROWSER_FALLBACK_PORT = DEFAULT_PORT;
