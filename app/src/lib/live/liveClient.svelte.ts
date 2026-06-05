/*
 * liveClient.svelte.ts — the GUI side of the live pi link.
 *
 * Connects (as a WebSocket CLIENT) to the pi extension's server, builds a live
 * AccordionStore from the streamed context, and answers each `sync` with a fold
 * plan. In Milestone 1 the plan is always empty (`ops: []`) — the loop is proven
 * end-to-end while never altering a model call.
 *
 * It drives the SAME `session` object the rest of the UI already renders, so
 * "live mode" needs no new view: populating `session.store` is enough.
 */
import { session } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { wireToBlock } from "./mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, type ServerMessage, type PlanMessage, type FoldOp } from "./protocol";

let socket: WebSocket | null = null;
let manualClose = false;

/** Live connection status, for the UI. */
export const live = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
});

/**
 * The fold plan the GUI returns for a sync. Milestone 1: fold nothing. Milestone 2
 * reads the live store's auto-fold decisions and emits one op per folded block,
 * carrying the digest text (computed GUI-side via engine/digest).
 */
function computePlan(): FoldOp[] {
	return [];
}

export function connectLive(port: number = DEFAULT_PORT): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	disconnectLive(); // drop any prior socket
	manualClose = false;
	live.status = "connecting";
	live.detail = `ws://127.0.0.1:${port}`;
	session.error = "";

	let ws: WebSocket;
	try {
		ws = new WebSocket(`ws://127.0.0.1:${port}`);
	} catch (e) {
		live.status = "error";
		live.detail = e instanceof Error ? e.message : String(e);
		return;
	}
	socket = ws;

	ws.onmessage = (ev) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
		} catch {
			return;
		}
		if (!isServerMessage(parsed)) return; // ignore anything off-protocol
		const msg: ServerMessage = parsed;
		if (msg.type === "hello") {
			live.status = "connected";
			session.error = "";
			session.live = true;
			session.filePath = null;
			session.store = new AccordionStore({
				meta: { format: "pi", title: msg.meta.title || "live pi session", cwd: msg.meta.cwd || "", model: msg.meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
		} else if (msg.type === "sync") {
			if (!session.store) return;
			if (msg.full) {
				// structural reset — rebuild from scratch
				session.store = new AccordionStore({
					meta: session.store.meta,
					blocks: [],
					lineCount: 0,
					skipped: 0,
				});
			}
			session.store.appendBlocks(msg.blocks.map(wireToBlock));
			const reply: PlanMessage = { type: "plan", reqId: msg.reqId, ops: computePlan() };
			try {
				ws.send(JSON.stringify(reply));
			} catch {
				/* socket gone — extension will time out and pass through */
			}
		}
	};

	ws.onerror = () => {
		live.status = "error";
		live.detail = `could not reach pi on :${port} — is a pi session running with the accordion extension?`;
	};

	ws.onclose = () => {
		session.live = false;
		if (socket === ws) socket = null;
		if (!manualClose && live.status !== "error") {
			live.status = "idle";
			live.detail = "disconnected";
		}
	};
}

export function disconnectLive(): void {
	manualClose = true;
	session.live = false;
	if (socket) {
		try {
			socket.close();
		} catch {
			/* ignore */
		}
		socket = null;
	}
	if (live.status !== "error") live.status = "idle";
}

/** Reserved for M2: kept so the import graph and protocol version are referenced. */
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
