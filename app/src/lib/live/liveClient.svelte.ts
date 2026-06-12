/*
 * liveClient.svelte.ts — the GUI side of the live pi link.
 *
 * Connects (as a WebSocket CLIENT) to the pi extension's server and keeps a
 * live AccordionStore in sync with the Conductor's authoritative state.
 *
 * Role: MIRROR, not driver. The Conductor (inside the extension) decides what
 * to fold. This client receives the Conductor's decisions in every sync and
 * applies them to the store — the GUI no longer computes its own fold plan.
 *
 * User actions (fold/unfold/pin/group) travel the other direction: the GUI
 * sends a `userAction` message the moment the user clicks. The extension applies
 * it to AccordionState immediately; the next sync surfaces the result.
 */
import { session, cancelPendingLoad } from "../session.svelte";
import { AccordionStore } from "../engine/store.svelte";
import { wireToBlock } from "./mapping";
import { DEFAULT_PORT, PROTOCOL_VERSION, isServerMessage, type ServerMessage, type SyncMessage, type UserActionMessage } from "./protocol";
import { ghostStart, ghostEnd, ghostClearAll } from "./ghostState.svelte";

let socket: WebSocket | null = null;
let manualClose = false;
let budgetLive = false;

/** Live connection status, for the UI. */
export const live = $state<{ status: "idle" | "connecting" | "connected" | "error"; detail: string }>({
	status: "idle",
	detail: "",
});

/** Send a user action to the extension immediately. No-op if not connected. */
export function sendUserAction(action: UserActionMessage): void {
	if (!socket || socket.readyState !== 1) return;
	try { socket.send(JSON.stringify(action)); } catch { /* socket gone */ }
}

/**
 * Apply the authoritative snapshot from a sync message to the store.
 * The Conductor's foldedBlockIds / pinnedBlockIds / groups are the ground truth;
 * the store's local fold state is overwritten to match.
 */
function applySnapshot(store: AccordionStore, msg: SyncMessage): void {
	store.applyLiveSnapshot(
		msg.foldedBlockIds ?? [],
		msg.pinnedBlockIds ?? [],
		msg.groups ?? [],
		msg.foldLevels ?? {},
		msg.foldedDigests ?? {},
	);
	if (msg.decisions?.length) {
		store.recordConductorDecisions(msg.decisions);
	}
}

export function connectLive(port: number = DEFAULT_PORT): void {
	if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
	cancelPendingLoad();
	disconnectLive();
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
		} catch { return; }
		if (!isServerMessage(parsed)) return;
		const msg: ServerMessage = parsed;

		if (msg.type === "hello") {
			if (msg.protocolVersion !== PROTOCOL_VERSION) {
				live.status = "error";
				live.detail = `protocol mismatch — extension v${msg.protocolVersion}, app v${PROTOCOL_VERSION}; update both to the same version`;
				try { ws.close(); } catch { /* ignore */ }
				return;
			}
			live.status = "connected";
			session.error = "";
			session.live = true;
			session.filePath = null;
			session.readOnly = false;
			ghostClearAll();
			budgetLive = false;
			session.store = new AccordionStore({
				meta: { format: "pi", title: msg.meta.title || "live pi session", cwd: msg.meta.cwd || "", model: msg.meta.model || "" },
				blocks: [],
				lineCount: 0,
				skipped: 0,
			});
			if (typeof msg.meta.contextWindow === "number" && msg.meta.contextWindow > 0) {
				session.store.setContextWindow(msg.meta.contextWindow);
				// Restore user-saved budget from localStorage; fall back to contextWindow.
				let savedBudget: number | null = null;
				try {
					const raw = localStorage.getItem("accordion.budget");
					if (raw) { const n = Number(raw); if (Number.isFinite(n) && n > 0) savedBudget = n; }
				} catch {}
				session.store.setBudget(savedBudget ?? msg.meta.contextWindow);
				budgetLive = true;
			}
			// Mark the store as live-mirror mode: local auto-folder is disabled,
			// fold state comes from Conductor snapshots.
			session.store.setLiveMode(true);

		} else if (msg.type === "sync") {
			if (!session.store) return;

			if (msg.full) {
				ghostClearAll();
				const prevContextWindow = session.store.contextWindow;
				const prevBudget = session.store.budget;
				const prevProtect = session.store.protectTokens;
				session.store = new AccordionStore({
					meta: session.store.meta,
					blocks: [],
					lineCount: 0,
					skipped: 0,
				});
				session.store.setLiveMode(true);
				if (prevContextWindow !== null) session.store.setContextWindow(prevContextWindow);
				session.store.setBudget(prevBudget);
				session.store.setProtect(prevProtect);
			}

			const cw = msg.contextWindow;
			if (typeof cw === "number" && cw > 0) {
				const prev = session.store.contextWindow;
				session.store.setContextWindow(cw);
				if (!budgetLive || (prev !== null && prev !== cw)) {
					session.store.setBudget(cw);
					budgetLive = true;
				}
			}

			session.store.appendBlocks(msg.blocks.map(wireToBlock));
			applySnapshot(session.store, msg);

		} else if (msg.type === "stream") {
			if (msg.phase === "start") {
				ghostStart(msg.kind, msg.contentIndex);
			} else if (msg.phase === "abort") {
				if (msg.contentIndex < 0) {
					ghostClearAll();
				} else {
					ghostEnd(msg.contentIndex);
				}
			}
		}
	};

	ws.onerror = () => {
		live.status = "error";
		live.detail = `could not reach pi on :${port} — is a pi session running with the accordion extension?`;
	};

	ws.onclose = () => {
		session.live = false;
		ghostClearAll();
		if (socket === ws) {
			socket = null;
			if (!manualClose && live.status !== "error") {
				live.status = "idle";
				live.detail = "disconnected";
			}
		}
		if (session.store) session.store.setLiveMode(false);
	};
}

export function disconnectLive(): void {
	manualClose = true;
	budgetLive = false;
	session.live = false;
	ghostClearAll();
	if (socket) {
		try { socket.close(); } catch { /* ignore */ }
		socket = null;
	}
	if (live.status !== "error") live.status = "idle";
	if (session.store) session.store.setLiveMode(false);
}

/** The protocol version this client speaks. */
export const CLIENT_PROTOCOL_VERSION = PROTOCOL_VERSION;
