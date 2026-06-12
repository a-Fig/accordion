/*
 * protocol.ts — the wire contract between the pi extension and the Accordion GUI.
 *
 * This file is the SINGLE SOURCE OF TRUTH for the live link. It is imported by
 * both the GUI (app/src/lib/live/*) and the pi extension (src/accordion.ts) so
 * the two can never drift. Keep it dependency-free and types-only at runtime —
 * no imports from the rest of the app.
 *
 * ── Roles (merged Conductor + live link) ──────────────────────────────────────
 *   • The pi EXTENSION hosts a WebSocket server on an ephemeral loopback port.
 *   • The GUI webview connects as a WebSocket CLIENT.
 *   • The Conductor (inside the extension) is the AUTHORITATIVE decision maker:
 *     it decides what to fold/unfold/pin every context turn. The GUI MIRRORS that
 *     decision — it does not compute its own fold plan.
 *
 * ── Per-turn loop ──────────────────────────────────────────────────────────
 *   1. pi's `context` hook fires in the extension (before a model call).
 *   2. Extension runs the Conductor on `AccordionState` + the messages.
 *   3. Extension sends `sync` to the GUI with the new blocks AND the authoritative
 *      snapshot (foldedBlockIds, pinnedBlockIds, groups) AND this turn's decisions.
 *   4. Extension returns the Conductor's assembled messages to pi for the model.
 *   5. GUI updates its view from the snapshot and renders new decisions in the
 *      activity panel. The GUI never replies with a fold plan — it has no plan.
 *
 * ── User actions ───────────────────────────────────────────────────────────
 *   User clicks fold/unfold/pin/group in the GUI → GUI sends a `userAction` message
 *   on demand. Extension applies it to AccordionState IMMEDIATELY. The Conductor
 *   reads the resulting state on its next `context` hook. A block the user just
 *   acted on is left alone by the Conductor for that turn (manual override).
 *
 * ── Agent unfold ──────────────────────────────────────────────────────────
 *   The agent calls `accordion_unfold` directly (via the registered agent tool).
 *   This mutates AccordionState in the extension; no WebSocket round-trip needed.
 *   The GUI sees the result via the next sync's snapshot.
 */

/** Bump on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 5;

/**
 * Browser dev-loop fallback port only. In the desktop ("pull") model each pi
 * session binds an EPHEMERAL port and advertises it via the registry (registry.ts),
 * which the app discovers — so this constant is NOT what a real session listens on.
 * It is just the default the browser manual-connect input pre-fills.
 */
export const DEFAULT_PORT = 4317;

/**
 * Fixed loopback port for the HTTP discovery endpoint. One pi process holds this
 * at a time (first-come-first-served); the browser dev client polls it to get the
 * session list from ~/.accordion/sessions/ without Tauri native commands.
 */
export const DISCOVERY_PORT = 4316;

/**
 * A serialisable block — the wire form of engine `Block`, minus the reactive
 * fold state (the GUI mirrors fold state from the snapshot, not from per-block
 * fields). `id` is assigned by the extension using durable, content-anchored
 * identity — identical whether derived now or after the message array shifts:
 *   • `u:<timestamp>`                      — a user message
 *   • `a:<responseId|"t"+timestamp>:p<j>`  — part j of an assistant message
 *     (kind: thinking | text | tool_call); prefers responseId, falls back to timestamp
 *   • `r:<toolCallId>`                     — a tool_result message
 *   • `s:<timestamp>`                      — a summary/other message
 * Fallback (anchor field absent): positional `m<i>:u`, `m<i>:p<j>`, `m<i>:r`,
 * `m<i>:s` — ensures nothing crashes on malformed messages.
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

/**
 * A multiblock fold (group) on the wire. Mirrors the GUI's `Group` and the
 * Conductor's `AccordionState.groups` entry. Member ids must be durable.
 */
export interface WireGroup {
	id: string;
	memberIds: string[];
	folded: boolean;
}

/**
 * One Conductor decision, sent in `SyncMessage.decisions` so the GUI can render
 * a faithful activity panel. Mirrors `FoldDecision` in `src/conductor.ts` — the
 * shape lives here too so the GUI can type its inbound stream without importing
 * from the extension code.
 */
export interface WireFoldDecision {
	blockId: string;
	action: "fold" | "unfold" | "pin" | "unpin";
	actor: "conductor" | "you" | "agent";
	reason: string | string[];
	turn: number;
	kind: WireBlock["kind"];
	callId?: string;
	level?: 0 | 1 | 2 | 3;
	fromLevel?: 0 | 1 | 2 | 3;
}

// ── Server → client (extension → GUI) ────────────────────────────────────────

/** Sent once when the GUI connects. */
export interface HelloMessage {
	type: "hello";
	protocolVersion: number;
	sessionId: string;
	meta: { title: string; cwd: string; model: string; contextWindow: number | null; format: "pi" };
}

/**
 * Sent on every `context` hook AND whenever the extension wants the GUI to
 * refresh its view (model swap, message_end, agent_end). `blocks` are the blocks
 * ADDED since the previous sync (the whole context when `full` is true — i.e.
 * the first sync, or after a structural reset). `foldedBlockIds`/`pinnedBlockIds`/
 * `groups` are the AUTHORITATIVE snapshot of Conductor state — always complete,
 * never deltas — so a reconnecting GUI always catches up to ground truth in one
 * message. `decisions` lists the decisions emitted THIS turn (for the activity
 * panel); it is delta, not cumulative.
 *
 * `contextWindow` is the model's total token capacity (best-effort).
 */
export interface SyncMessage {
	type: "sync";
	reqId: number;
	full: boolean;
	blocks: WireBlock[];
	contextWindow?: number | null;
	/** Authoritative snapshot of every block currently folded by the Conductor. */
	foldedBlockIds: string[];
	/** Authoritative snapshot of every block currently pinned. */
	pinnedBlockIds: string[];
	/** Authoritative snapshot of every group in the session, with its folded state. */
	groups: WireGroup[];
	/**
	 * Fold level per block id (live-link ids). Absent or 0 means full.
	 * 1 = trim (structured excerpt) · 2 = digest (one-liner) · 3 = group member.
	 */
	foldLevels: Record<string, 0 | 1 | 2 | 3>;
	/**
	 * The exact text the agent receives for each folded block (live-link ids).
	 * Includes LLM summaries when cached, deterministic digest otherwise.
	 * The GUI renders this verbatim so the Inspector shows exactly what the model sees.
	 */
	foldedDigests: Record<string, string>;
	/** Decisions emitted during THIS context hook (delta, not cumulative). */
	decisions: WireFoldDecision[];
}

/**
 * Sent by the extension to inform the GUI that a content part is forming (phase:
 * "start"), has finished (phase: "end"), or was aborted due to an error (phase:
 * "abort"). Carries NO content, NO token count — only identity (kind + contentIndex)
 * and the lifecycle phase. Drives presentation-only ghost state in the GUI.
 *
 * contentIndex: the assistantMessageEvent's contentIndex (0-based part index).
 * When contentIndex < 0 in an "abort" frame it means "clear ALL active ghosts."
 */
export interface StreamMessage {
	type: "stream";
	phase: "start" | "end" | "abort";
	kind: "thinking" | "text" | "tool_call";
	contentIndex: number;
}

export type ServerMessage = HelloMessage | SyncMessage | StreamMessage;

// ── Client → server (GUI → extension) ────────────────────────────────────────

/**
 * One user action dispatched from the GUI the moment the user does it.
 *
 *   • `fold` / `unfold` / `pin` / `unpin` — single-block actions. `blockId` required.
 *   • `groupCreate` — create a group spanning `startId..endId` (inclusive). The
 *     extension snaps to whole messages and refuses overlap, same rules as the
 *     engine's `createGroup`.
 *   • `groupDelete` — remove a group (members return to their per-block fold state).
 *   • `groupFold` / `groupUnfold` — toggle a group's folded flag.
 *
 * Extension applies the change to AccordionState immediately; the next `sync`
 * surfaces it back to the GUI as part of the authoritative snapshot.
 */
export interface UserActionMessage {
	type: "userAction";
	action:
		| "fold"
		| "unfold"
		| "pin"
		| "unpin"
		| "groupCreate"
		| "groupDelete"
		| "groupFold"
		| "groupUnfold";
	blockId?: string;
	startId?: string;
	endId?: string;
	groupId?: string;
}

/** Optional: the GUI announcing itself (reserved). */
export interface AttachMessage {
	type: "attach";
	protocolVersion: number;
}

export type ClientMessage = UserActionMessage | AttachMessage;

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isServerMessage(v: unknown): v is ServerMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	const t = (v as any).type;
	return t === "hello" || t === "sync" || t === "stream";
}

export function isClientMessage(v: unknown): v is ClientMessage {
	if (!v || typeof v !== "object" || !("type" in v)) return false;
	const t = (v as any).type;
	return t === "userAction" || t === "attach";
}
