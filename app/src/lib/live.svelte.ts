/*
 * live.svelte.ts — singleton live-session connection, shared across routes.
 *
 * Browser dev: EventSource on same origin (:1420 Vite plugin).
 * Tauri native: Rust file watcher + Tauri events (no HTTP sidecar).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { setCommandSender } from "./engine/command-bus";
import { conductorSettings } from "./engine/conductor-settings.svelte";
import { parse } from "./engine/parse";
import { AccordionStore } from "./engine/store.svelte";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const LIVE_BASE_URL = (env?.VITE_ACCORDION_LIVE_URL ?? "").replace(/\/$/, "");
const LIVE_URL = `${LIVE_BASE_URL}/api/live-session/events`;
const COMMANDS_URL = `${LIVE_BASE_URL}/api/conductor-commands`;
const LS_KEY = "accordion.liveMode";

function inTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

class LiveSession {
	enabled = $state(false);
	connected = $state(false);
	hint = $state("");
	store = $state<AccordionStore | null>(null);
	private es: EventSource | null = null;
	private unlisteners: UnlistenFn[] = [];
	private buffer = "";
	private staleTimer: ReturnType<typeof setTimeout> | null = null;
	private gotEvent = false;

	constructor() {
		if (typeof window === "undefined") return;
		if (window.localStorage.getItem(LS_KEY) === "1") this.enable();
	}

	toggle(): void {
		this.enabled ? this.disable() : this.enable();
	}

	enable(): void {
		if (this.enabled && (this.es || this.unlisteners.length)) return;
		this.enabled = true;
		if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, "1");
		this.connect();
	}

	disable(): void {
		this.enabled = false;
		if (typeof window !== "undefined") window.localStorage.setItem(LS_KEY, "0");
		this.teardown();
		this.connected = false;
		conductorSettings.setLiveConnected(false);
		setCommandSender(null);
		this.hint = "";
	}

	private teardown(): void {
		this.es?.close();
		this.es = null;
		for (const u of this.unlisteners) u();
		this.unlisteners = [];
		if (inTauri()) invoke("stop_live_watch").catch(() => {});
		if (this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
		}
	}

	private connect(): void {
		this.teardown();
		this.buffer = "";
		this.gotEvent = false;
		if (inTauri()) {
			this.connectTauri();
		} else {
			this.connectSse();
		}
	}

	private markEvent(): void {
		this.gotEvent = true;
		if (this.staleTimer) {
			clearTimeout(this.staleTimer);
			this.staleTimer = null;
		}
	}

	private connectSse(): void {
		this.hint = LIVE_BASE_URL ? `Connecting to ${LIVE_BASE_URL}…` : "Connecting to live session…";
		const es = new EventSource(LIVE_URL);
		es.addEventListener("snapshot", (e: MessageEvent) => {
			this.markEvent();
			this.ingestSnapshot(JSON.parse(e.data));
		});
		es.addEventListener("append", (e: MessageEvent) => {
			this.markEvent();
			this.ingestAppend(JSON.parse(e.data));
		});
		es.onopen = () => {
			this.connected = true;
			conductorSettings.setLiveConnected(true);
			setCommandSender((cmd) => {
				fetch(COMMANDS_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(cmd),
				}).catch(() => {/* fire-and-forget */});
			});
			this.hint = "Connected — waiting for first snapshot…";
			this.staleTimer = setTimeout(() => {
				if (!this.gotEvent)
					this.hint = "Connected but no snapshot — start pi with the accordion extension and run /accordion.";
			}, 2500);
		};
		es.onerror = () => {
			this.connected = false;
			conductorSettings.setLiveConnected(false);
			setCommandSender(null);
			this.hint = LIVE_BASE_URL
				? `Can't reach ${LIVE_BASE_URL} — check the live URL or restart the dev server.`
				: "Can't reach live session — restart `npm run dev` in app/.";
		};
		this.es = es;
	}

	private async connectTauri(): Promise<void> {
		this.hint = "Connecting to live session…";
		try {
			const u1 = await listen<string>("live-session-snapshot", (e) => {
				this.markEvent();
				this.ingestSnapshot(e.payload);
			});
			const u2 = await listen<string>("live-session-append", (e) => {
				this.markEvent();
				this.ingestAppend(e.payload);
			});
			this.unlisteners = [u1, u2];
			await invoke("start_live_watch");
			this.connected = true;
			conductorSettings.setLiveConnected(true);
			// TODO: replace with Tauri invoke("post_conductor_command") for native path
			setCommandSender((cmd) => {
				fetch(COMMANDS_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(cmd),
				}).catch(() => {/* fire-and-forget */});
			});
			this.hint = "Connected — waiting for first snapshot…";
			this.staleTimer = setTimeout(() => {
				if (!this.gotEvent)
					this.hint = "Waiting for pi — start it with the accordion extension and run /accordion.";
			}, 2500);
		} catch {
			this.connected = false;
			conductorSettings.setLiveConnected(false);
			setCommandSender(null);
			this.hint = "Failed to start native live watch.";
		}
	}

	private ingestSnapshot(raw: string): void {
		this.buffer = raw;
		if (!raw.trim()) {
			this.hint = "Waiting for pi — start it with the accordion extension and run /accordion.";
			return;
		}
		this.hint = "";
		try {
			const parsed = parse(raw);
			conductorSettings.applySession(parsed.conductor);
			const s = new AccordionStore(parsed);
			s.liveConnected = true;
			this.store = s;
			if (typeof window !== "undefined") (window as any).__store = s;
		} catch (e) {
			this.hint = e instanceof Error ? e.message : String(e);
		}
	}

	private ingestAppend(chunk: string): void {
		if (!chunk) return;
		this.buffer += chunk;
		try {
			const parsed = parse(this.buffer);
			conductorSettings.applySession(parsed.conductor);
			if (this.store) this.store.mergeFrom(parsed);
			else {
				const s = new AccordionStore(parsed);
				s.liveConnected = true;
				this.store = s;
				if (typeof window !== "undefined") (window as any).__store = s;
			}
			this.hint = "";
		} catch {
			/* tolerate a half-written line; next chunk will complete it */
		}
	}
}

export const live = new LiveSession();
