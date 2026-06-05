/*
 * smoke.mjs — exercise the extension's WS loop without running pi.
 *
 * Loads accordion.ts via jiti (the same loader pi uses → proves the cross-package
 * relative imports resolve), drives it with a mock `pi`, connects a real WS client
 * as the "GUI", and checks the full hello → sync → plan → apply path end to end.
 *
 * Run: node smoke.mjs
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");

// ── mock pi ──────────────────────────────────────────────────────────────────
const handlers = {};
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerCommand: () => {},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = { ui: { setStatus() {}, notify() {}, theme: { fg: (_c, s) => s } }, sessionManager: { getBranch: () => [] } };
handlers.session_start({}, ctx);

// passthrough invariant: with NO GUI attached, the context hook must return
// undefined (pi keeps its original messages) and never touch them.
{
	const probe = [{ role: "user", content: "no gui yet" }];
	const ret = await Promise.resolve(handlers.context({ messages: probe }, ctx));
	if (ret !== undefined) {
		console.error("SMOKE FAIL: context hook altered messages with no GUI attached");
		process.exit(1);
	}
}

// 4 messages; we'll fold the first assistant text (m1:p0), which sits OUTSIDE the
// last-2-messages backstop, so the fold must take effect.
const sample = [
	{ role: "user", content: "do the thing" },
	{ role: "assistant", content: [{ type: "text", text: "ORIGINAL ASSISTANT TEXT" }] },
	{ role: "user", content: "and another" },
	{ role: "assistant", content: [{ type: "text", text: "second reply" }] },
];

const seen = { hello: false, sync: false, syncBlocks: 0 };
let contextReturn;

const ws = new WebSocket("ws://127.0.0.1:4317");
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("smoke timed out")), 3000);
	ws.on("error", reject);
	ws.on("message", async (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "hello") {
			seen.hello = true;
			// fire the context hook now that the GUI is attached
			contextReturn = await Promise.resolve(handlers.context({ messages: sample }, ctx));
			// give the resolved value a tick, then finish
		} else if (m.type === "sync") {
			seen.sync = true;
			seen.syncBlocks = m.blocks.length;
			ws.send(JSON.stringify({ type: "plan", reqId: m.reqId, ops: [{ id: "m1:p0", digestText: "FOLDED" }] }));
			setTimeout(() => {
				clearTimeout(timeout);
				resolve();
			}, 150);
		}
	});
});
ws.close();

// ── assertions ───────────────────────────────────────────────────────────────
const fails = [];
if (!seen.hello) fails.push("never received hello");
if (!seen.sync) fails.push("never received sync");
if (seen.syncBlocks < 4) fails.push(`expected >=4 blocks in sync, got ${seen.syncBlocks}`);
if (!contextReturn || !contextReturn.messages) fails.push("context hook did not return replacement messages");
else {
	const foldedText = contextReturn.messages[1]?.content?.[0]?.text;
	if (foldedText !== "FOLDED") fails.push(`m1:p0 not folded — got ${JSON.stringify(foldedText)}`);
	const protectedText = contextReturn.messages[3]?.content?.[0]?.text;
	if (protectedText !== "second reply") fails.push("recent message was unexpectedly altered");
}

if (fails.length) {
	console.error("SMOKE FAIL:\n - " + fails.join("\n - "));
	process.exit(1);
}
console.log(`SMOKE PASS — hello ✓  sync(${seen.syncBlocks} blocks) ✓  plan applied per-block ✓  backstop intact ✓`);
process.exit(0);
