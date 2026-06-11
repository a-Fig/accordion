/*
 * live-session-bridge.ts — Node-only live session API (SSE + snapshot + command bridge).
 * Used by the Vite dev plugin; mirrors the former visualizer/serve.js contract.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const LIVE_PATH = path.join(os.homedir(), ".pi", "agent", "accordion-live-session.jsonl");
export const COMMANDS_PATH = path.join(os.homedir(), ".pi", "agent", "accordion-commands.jsonl");

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

interface SseClient {
	res: ServerResponse;
	cursor: number;
}

const sseClients = new Set<SseClient>();
let watcher: fs.FSWatcher | null = null;

function sseSend(res: ServerResponse, event: string, data: string): void {
	try {
		res.write(`event: ${event}\ndata: ${data}\n\n`);
	} catch {
		/* client gone */
	}
}

function readTail(cursor: number): Promise<{ size: number; chunk: string; reset?: boolean }> {
	return new Promise((resolve) => {
		fs.stat(LIVE_PATH, (err, st) => {
			if (err) return resolve({ size: 0, chunk: "" });
			const size = st.size;
			if (size < cursor) {
				fs.readFile(LIVE_PATH, "utf8", (e2, full) => {
					if (e2) return resolve({ size: 0, chunk: "" });
					resolve({ size, chunk: full, reset: true });
				});
				return;
			}
			if (size === cursor) return resolve({ size, chunk: "" });
			const stream = fs.createReadStream(LIVE_PATH, { start: cursor, end: size - 1, encoding: "utf8" });
			let buf = "";
			stream.on("data", (d) => (buf += d));
			stream.on("end", () => resolve({ size, chunk: buf }));
			stream.on("error", () => resolve({ size: cursor, chunk: "" }));
		});
	});
}

let watchTick = Promise.resolve();

function ensureWatcher(): void {
	if (watcher) return;
	try {
		watcher = fs.watch(LIVE_PATH, () => {
			watchTick = watchTick.then(async () => {
				for (const client of sseClients) {
					const { size, chunk, reset } = await readTail(client.cursor);
					if (reset) {
						client.cursor = size;
						sseSend(client.res, "snapshot", JSON.stringify(chunk));
					} else if (chunk) {
						client.cursor = size;
						sseSend(client.res, "append", JSON.stringify(chunk));
					}
				}
			});
		});
		watcher.on("error", () => {
			watcher = null;
		});
	} catch {
		/* file may not exist yet */
	}
}

/** Connect-style middleware for /api/live-session and /api/live-session/events */
export function liveSessionMiddleware(
	req: IncomingMessage,
	res: ServerResponse,
	next: () => void,
): void {
	const p = decodeURIComponent((req.url ?? "").split("?")[0]);

	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS);
		res.end();
		return;
	}

	if (p === "/api/live-session") {
		fs.readFile(LIVE_PATH, "utf8", (err, data) => {
			if (err) {
				res.writeHead(404, { ...CORS, "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: "No live session yet — start pi with the accordion extension and run /accordion.",
					}),
				);
				return;
			}
			res.writeHead(200, {
				...CORS,
				"Content-Type": "application/x-ndjson; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(data);
		});
		return;
	}

	if (p === "/api/live-session/events") {
		res.writeHead(200, {
			...CORS,
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("retry: 1500\n\n");
		fs.readFile(LIVE_PATH, "utf8", (err, data) => {
			const initial = err ? "" : data;
			const cursor = err ? 0 : Buffer.byteLength(initial, "utf8");
			sseSend(res, "snapshot", JSON.stringify(initial));
			const client: SseClient = { res, cursor };
			sseClients.add(client);
			ensureWatcher();
			req.on("close", () => sseClients.delete(client));
		});
		return;
	}

	if (p === "/api/conductor-commands" && req.method === "POST") {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => (body += chunk));
		req.on("end", () => {
			try {
				JSON.parse(body); // validate
				fs.appendFile(COMMANDS_PATH, body.trim() + "\n", (err) => {
					if (err) {
						res.writeHead(500, { ...CORS, "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: String(err) }));
					} else {
						res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true }));
					}
				});
			} catch {
				res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid JSON" }));
			}
		});
		return;
	}

	next();
}
