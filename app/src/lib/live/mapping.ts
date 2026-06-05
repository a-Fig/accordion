/*
 * mapping.ts — the message ↔ block bridge for the live pi link.
 *
 * SHARED by the GUI and the pi extension (imported from extension/accordion.ts),
 * so the provider-safety rules live in exactly one place. Pure + framework-free.
 *
 *   linearize(messages) → WireBlock[]   (pi's in-memory messages → our blocks)
 *   applyPlan(messages, ops) → messages (fold a block in place, provider-safely)
 *
 * Block ids encode the source location so a returned op applies without any
 * re-derivation:  m<i>:u (user) · m<i>:p<j> (assistant part) · m<i>:r (tool result).
 */
import type { WireBlock, FoldOp } from "./protocol";
import type { Block } from "../engine/types";
import { estTokens, BLOCK_OVERHEAD } from "../engine/tokens";

// ── Minimal structural types for pi's in-memory AgentMessage ─────────────────
// (We only model the fields we read; pi owns the real types.)
export interface PiTextPart {
	type: "text";
	text: string;
}
export interface PiThinkingPart {
	type: "thinking";
	thinking: string;
}
export interface PiToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}
export type PiPart = PiTextPart | PiThinkingPart | PiToolCallPart | { type: string; [k: string]: unknown };

export interface PiMessage {
	role: string;
	content?: string | PiPart[] | Array<{ type: string; text?: string }>;
	model?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	summary?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((b): b is { type: string; text: string } => !!b && (b as any).type === "text" && typeof (b as any).text === "string")
			.map((b) => b.text)
			.join("\n");
	return "";
}

const tokensFor = (text: string): number => estTokens(text) + BLOCK_OVERHEAD;

/**
 * Linearize pi's in-memory message array into wire blocks, mirroring the on-disk
 * parser (engine/parse.ts → parsePi) but operating on live messages. Deterministic:
 * same messages → same blocks/ids.
 */
export function linearize(messages: PiMessage[]): WireBlock[] {
	const out: WireBlock[] = [];
	let order = 0;
	let turn = 0;

	const push = (
		id: string,
		kind: WireBlock["kind"],
		text: string,
		extra: Partial<Pick<WireBlock, "toolName" | "callId" | "model" | "isError">> = {},
	) => {
		if (!text && kind !== "tool_result") return; // drop empty non-results (parity with parse.ts)
		out.push({ id, kind, turn, order: order++, text, tokens: tokensFor(text), ...extra });
	};

	messages.forEach((m, i) => {
		switch (m.role) {
			case "user": {
				turn += 1;
				push(`m${i}:u`, "user", textOf(m.content));
				break;
			}
			case "assistant": {
				const parts = Array.isArray(m.content) ? (m.content as PiPart[]) : [];
				parts.forEach((b, j) => {
					if (b?.type === "thinking") push(`m${i}:p${j}`, "thinking", (b as PiThinkingPart).thinking || "", { model: m.model });
					else if (b?.type === "text") push(`m${i}:p${j}`, "text", (b as PiTextPart).text || "", { model: m.model });
					else if (b?.type === "toolCall") {
						const c = b as PiToolCallPart;
						push(`m${i}:p${j}`, "tool_call", `${c.name} ${JSON.stringify(c.arguments ?? {})}`, {
							toolName: c.name,
							callId: c.id,
							model: m.model,
						});
					}
				});
				break;
			}
			case "toolResult": {
				push(`m${i}:r`, "tool_result", textOf(m.content), {
					toolName: m.toolName || "tool",
					callId: m.toolCallId,
					isError: !!m.isError,
				});
				break;
			}
			default: {
				// bash / custom / branchSummary / compactionSummary — surface any summary text
				if (typeof m.summary === "string" && m.summary) push(`m${i}:s`, "text", m.summary);
			}
		}
	});

	return out;
}

/** Convert a wire block back into a full engine Block (fresh, auto-controlled). */
export function wireToBlock(w: WireBlock): Block {
	return {
		id: w.id,
		kind: w.kind,
		turn: w.turn,
		order: w.order,
		text: w.text,
		tokens: w.tokens,
		toolName: w.toolName,
		callId: w.callId,
		model: w.model,
		isError: w.isError,
		override: null,
		autoFolded: false,
		by: null,
	};
}

/**
 * How many of the most-recent messages the extension refuses to fold no matter
 * what plan it receives — a coarse, local defense-in-depth backstop. The real,
 * token-based protected tail lives in the GUI engine; this only guards against a
 * buggy plan touching the very newest messages.
 */
export const PROTECT_RECENT_MSGS = 2;

/**
 * Apply a fold plan to pi's messages and return a NEW array (touched messages are
 * cloned; untouched ones are passed through by reference). Pure: the caller's array
 * is never mutated, so correctness never depends on pi's copy semantics. Provider-
 * safety rules, each defended by an explicit kind check so a mis-mapped id can never
 * fold the wrong part:
 *   • tool_result → replace content with one text part; keep toolCallId/toolName/isError
 *   • text        → replace the part's text with the (non-empty) digest
 *   • thinking    → replace the part's thinking with the digest (never drop → never empties a message)
 *   • tool_call   → NEVER folded (removing/altering it orphans its result → provider 400)
 *   • user / other→ NEVER folded
 * An op whose id resolves to a missing part, or to a part of the wrong kind, is
 * ignored — never applied blindly.
 */
export function applyPlan(messages: PiMessage[], ops: FoldOp[]): PiMessage[] {
	if (!ops.length) return messages;
	const byId = new Map(ops.map((o) => [o.id, o] as const));
	const protectFrom = messages.length - PROTECT_RECENT_MSGS;
	let changed = false;

	const out = messages.map((m, i) => {
		if (i >= protectFrom) return m; // backstop: never fold the most-recent messages

		if (m.role === "assistant" && Array.isArray(m.content)) {
			let parts: PiPart[] | null = null; // lazily cloned only if we actually fold
			(m.content as PiPart[]).forEach((b, j) => {
				const op = byId.get(`m${i}:p${j}`);
				if (!op || !op.digestText) return;
				if (b?.type === "text") {
					parts ??= (m.content as PiPart[]).slice();
					parts[j] = { ...(b as PiTextPart), text: op.digestText };
				} else if (b?.type === "thinking") {
					parts ??= (m.content as PiPart[]).slice();
					parts[j] = { ...(b as PiThinkingPart), thinking: op.digestText };
				}
				// tool_call or any other kind → ignored (never fold / id mis-map)
			});
			if (parts) {
				changed = true;
				return { ...m, content: parts };
			}
			return m;
		}

		if (m.role === "toolResult") {
			const op = byId.get(`m${i}:r`);
			if (op && op.digestText) {
				changed = true;
				return { ...m, content: [{ type: "text", text: op.digestText }] };
			}
			return m;
		}

		return m; // user / other: never folded
	});

	return changed ? out : messages;
}
