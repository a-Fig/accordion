/*
 * accordion.ts — the pi extension half of the Accordion live link.
 *
 * "GUI drives, extension is thin": this extension makes NO folding decisions. On
 * every `context` hook it linearizes pi's outgoing messages into blocks, streams
 * the new ones to the Accordion GUI over a WebSocket, awaits a fold plan, and
 * applies it to the messages pi is about to send. The GUI runs the engine.
 *
 * Safety (see docs/adr/0001-pi-live-integration.md):
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
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { linearize, applyPlan, type PiMessage } from "../app/src/lib/live/mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, type FoldOp, type ServerMessage } from "../app/src/lib/live/protocol";

const REQUEST_TIMEOUT_MS = 250; // how long pi waits on the GUI before passing through

export default function accordionLive(pi: ExtensionAPI): void {
	let wss: WebSocketServer | null = null;
	let client: WebSocket | null = null; // the GUI (one at a time in M1)
	let sessionId = "";
	let meta = { title: "pi session", cwd: "", model: "", format: "pi" as const };

	let sentCount = 0; // blocks already streamed to the current client
	let reqSeq = 0;
	let epoch = 0; // bumped on every new GUI connection; invalidates in-flight requests
	const pending = new Map<number, (ops: FoldOp[]) => void>();

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

	function startServer(): void {
		if (wss) return;
		try {
			wss = new WebSocketServer({ host: "127.0.0.1", port: DEFAULT_PORT });
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
			/* e.g. port already in use — run headless (passthrough) */
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
		sessionId = `s-${Date.now()}`;
		sentCount = 0;
		try {
			meta = { title: "pi session", cwd: (process?.cwd?.() ?? ""), model: "", format: "pi" };
		} catch {
			/* keep defaults */
		}
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
	pi.on("context", async (event, _ctx) => {
		const myEpoch = epoch;
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

	// ── /accordion : quick status in the terminal ───────────────────────────────
	pi.registerCommand("accordion", {
		description: "Show Accordion live-link status (GUI attached? blocks streamed?)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines = [
				`Accordion live link — port ${DEFAULT_PORT}`,
				`GUI: ${attached() ? "ATTACHED — folding driven by the app" : "detached — passthrough, native /compact allowed"}`,
				`blocks streamed this connection: ${sentCount}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
