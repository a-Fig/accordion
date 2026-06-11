/*
 * command-bus.ts — Thin decoupled bus for sending commands from app → pi.
 *
 * Breaking the circular dep: live.svelte.ts → store.svelte.ts ← command-bus ← live.svelte.ts
 * by keeping the sender in this neutral module that both sides can import.
 */

let sender: ((cmd: unknown) => void) | null = null;

export function setCommandSender(fn: ((cmd: unknown) => void) | null): void {
	sender = fn;
}

export function postLiveCommand(cmd: unknown): void {
	sender?.(cmd);
}
