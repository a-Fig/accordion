/*
 * smoke.mjs — exercise the extension's WS loop + registry without running pi.
 *
 * Loads accordion.ts via jiti (the same loader pi uses → proves the cross-package
 * relative imports resolve), drives it with a mock `pi`, discovers the session's
 * ephemeral port from the registry file it writes, connects a real WS client as
 * the "GUI", and checks hello → sync → plan → apply plus the discovery contract
 * (registry advertise / focus request / shutdown cleanup).
 *
 * Run: node smoke.mjs
 */
import { createJiti } from "jiti";
import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Point the registry at a throwaway dir BEFORE loading the extension (it reads
// ACCORDION_HOME at module load) so we never touch the real ~/.accordion.
const HOME = path.join(os.tmpdir(), `accordion-smoke-${process.pid}`);
process.env.ACCORDION_HOME = HOME;
const SESSIONS_DIR = path.join(HOME, ".accordion", "sessions");
const FOCUS_PATH = path.join(HOME, ".accordion", "focus.json");

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./accordion.ts");
const accordionLive = mod.default;
if (typeof accordionLive !== "function") throw new Error("default export is not a function");

async function waitFor(predicate, ms, label) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}
function readOnlyEntry() {
	const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
	if (files.length !== 1) throw new Error(`expected 1 registry entry, found ${files.length}`);
	return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, files[0]), "utf8"));
}

// ── mock pi ──────────────────────────────────────────────────────────────────
const handlers = {};
let accordionCmd = null;
const pi = {
	on: (name, fn) => (handlers[name] = fn),
	registerCommand: (name, def) => {
		if (name === "accordion") accordionCmd = def.handler;
	},
	appendEntry: () => {},
};
accordionLive(pi);
const ctx = {
	ui: { setStatus() {}, notify() {}, theme: { fg: (_c, s) => s } },
	getModel: () => ({ id: "test/model", contextWindow: 1000 }),
	getContextUsage: () => ({ tokens: 42, contextWindow: 1000 }),
};
handlers.session_start({}, ctx);

// the server binds an ephemeral port asynchronously, then advertises itself
await waitFor(() => fs.existsSync(SESSIONS_DIR) && fs.readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json")), 3000, "registry entry");
const entry = readOnlyEntry();
const fails = [];
if (!(entry.port > 0)) fails.push(`registry port not assigned (got ${entry.port})`);
if (entry.registryProtocol !== 1) fails.push(`registry protocol mismatch (${entry.registryProtocol})`);
if (entry.model !== "test/model") fails.push(`model not captured (${entry.model})`);
if (entry.tokens !== 42) fails.push(`tokens not captured (${entry.tokens})`);
const PORT = entry.port;

// passthrough invariant: with NO GUI attached, the context hook must return
// undefined (pi keeps its original messages) and never touch them.
{
	const probe = [{ role: "user", content: "no gui yet" }];
	const ret = await Promise.resolve(handlers.context({ messages: probe }, ctx));
	if (ret !== undefined) fails.push("context hook altered messages with no GUI attached");
}

// /accordion writes a one-shot focus request
if (accordionCmd) {
	await Promise.resolve(accordionCmd("", ctx));
	if (!fs.existsSync(FOCUS_PATH)) fails.push("/accordion did not write a focus request");
	else {
		const req = JSON.parse(fs.readFileSync(FOCUS_PATH, "utf8"));
		if (req.sessionId !== entry.sessionId) fails.push("focus request sessionId mismatch");
	}
} else {
	fails.push("accordion command was not registered");
}

// 4 messages; fold the first assistant text (m1:p0), OUTSIDE the last-2 backstop.
const sample = [
	{ role: "user", content: "do the thing" },
	{ role: "assistant", content: [{ type: "text", text: "ORIGINAL ASSISTANT TEXT" }] },
	{ role: "user", content: "and another" },
	{ role: "assistant", content: [{ type: "text", text: "second reply" }] },
];

const seen = { hello: false, sync: false, syncBlocks: 0 };
let contextReturn;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("smoke timed out")), 3000);
	ws.on("error", reject);
	ws.on("message", async (data) => {
		const m = JSON.parse(data.toString());
		if (m.type === "hello") {
			seen.hello = true;
			contextReturn = await Promise.resolve(handlers.context({ messages: sample }, ctx));
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

// shutdown must stop advertising (delete the registry entry)
handlers.session_shutdown({}, ctx);
await waitFor(() => !fs.existsSync(SESSIONS_DIR) || fs.readdirSync(SESSIONS_DIR).length === 0, 1000, "registry cleanup").catch(
	() => fails.push("session_shutdown did not delete the registry entry"),
);

// tidy the throwaway home
try {
	fs.rmSync(HOME, { recursive: true, force: true });
} catch {
	/* ignore */
}

if (fails.length) {
	console.error("SMOKE FAIL:\n - " + fails.join("\n - "));
	process.exit(1);
}
console.log(
	`SMOKE PASS — registry(port ${PORT}, model ✓, tokens ✓) ✓  no-GUI passthrough ✓  focus request ✓  ` +
		`hello ✓  sync(${seen.syncBlocks} blocks) ✓  plan applied per-block ✓  backstop ✓  shutdown cleanup ✓`,
);
process.exit(0);
