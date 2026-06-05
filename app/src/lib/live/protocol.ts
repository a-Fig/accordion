/*
 * protocol.ts — the wire contract between the pi extension and the Accordion GUI.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the live link. It is imported by
 * both the GUI (app/src/lib/live/*) and the pi extension (extension/accordion.ts,
 * via a relative import) so the two can never drift. Keep it dependency-free and
 * types-only at runtime — no imports from the rest of the app.
 *
 * ── Roles (Milestone 1) ────────────────────────────────────────────────────
 *   • The pi EXTENSION hosts a WebSocket server on PORT (127.0.0.1).
 *   • The GUI webview connects as a WebSocket CLIENT.
 *   • "GUI drives, extension is thin": the extension never decides what to fold.
 *     It linearizes pi's in-memory messages into blocks, streams them, and applies
 *     whatever fold plan the GUI returns. The GUI runs the engine (the brain).
 *
 * ── Per-turn loop ──────────────────────────────────────────────────────────
 *   1. pi's `context` hook fires in the extension (before a model call).
 *   2. Extension sends `sync` with the blocks added since the last sync.
 *   3. GUI updates its live store, runs the engine, replies `plan { ops }`.
 *   4. Extension applies the ops to the real messages and returns them to pi.
 *      If no GUI is connected, or the reply times out, the extension passes the
 *      messages through UNMODIFIED (never corrupts context).
 *
 * Milestone 1 deliberately ships an EMPTY plan (`ops: []`) from the GUI: the loop
 * is proven end-to-end while never altering a single model call.
 */

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 1;

/** Default loopback port the extension listens on / the GUI dials. */
export const DEFAULT_PORT = 4317;

/**
 * A serialisable block — the wire form of engine `Block`, minus the reactive
 * fold state (the GUI owns that). `id` is assigned by the extension and encodes
 * the block's location in pi's message array so a returned op can be applied
 * back without re-deriving anything:
 *   • `m<msgIndex>:p<partIndex>`  — a part of an assistant message
 *     (kind: thinking | text | tool_call)
 *   • `m<msgIndex>:r`             — a tool_result message
 *   • `m<msgIndex>:u`             — a user message
 */
export interface WireBlock {
	id: string;
	kind: "user" | "text" | "thinking" | "tool_call" | "tool_result";
	turn: number;
	order: number;
	text: string;
	tokens: number;
	toolName?: string;
	callId?: string;
	model?: string;
	isError?: boolean;
}

/** One fold instruction: replace block `id`'s content with `digestText`. */
export interface FoldOp {
	id: string;
	digestText: string;
}

// ── Server → client (extension → GUI) ────────────────────────────────────────

/** Sent once when the GUI connects. */
export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	sessionId: string;
	meta: { title: string; cwd: string; model: string; format: "pi" };
}

/**
 * Sent on every `context` hook. `blocks` are the blocks ADDED since the previous
 * sync (the whole context when `full` is true — i.e. the first sync, or after a
 * structural reset). `reqId` correlates the GUI's `plan` reply.
 */
export interface SyncMessage {
	type: "sync";
	reqId: number;
	full: boolean;
	blocks: WireBlock[];
}

export type ServerMessage = HelloMessage | SyncMessage;

// ── Client → server (GUI → extension) ────────────────────────────────────────

/** The GUI's reply to a `sync`. `ops: []` means "fold nothing". */
export interface PlanMessage {
	type: "plan";
	reqId: number;
	ops: FoldOp[];
}

/** Optional: the GUI announcing itself (reserved; unused in M1). */
export interface AttachMessage {
	type: "attach";
	protocolVersion: number;
}

export type ClientMessage = PlanMessage | AttachMessage;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isServerMessage(v: unknown): v is ServerMessage {
	return !!v && typeof v === "object" && "type" in v && ((v as any).type === "hello" || (v as any).type === "sync");
}

export function isClientMessage(v: unknown): v is ClientMessage {
	return !!v && typeof v === "object" && "type" in v && ((v as any).type === "plan" || (v as any).type === "attach");
}
