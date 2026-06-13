/*
 * attn.mjs — the bridge from the Relevance Lab harness to the Python
 * attention probe (scorer id "attn", v1).
 *
 * run.mjs calls this once per tick:
 *   default async ({ session, ticks, contexts, paths }) => void
 * with single-element `ticks` / `contexts` arrays. We:
 *   1. build the probe input JSON (tail + scored blocks [0, atBlock)),
 *   2. spawn  scoring/probe/.venv/Scripts/python.exe scoring/probe/probe.py,
 *   3. map the returned per-block scores onto the blockIds-aligned array,
 *   4. set ticks[0].scorers.attn meta + ticks[0].scores.attn.
 *
 * Per-tick caching under ~/.accordion/relevance/cache/attn/ so re-runs are
 * instant. Node ESM, Windows-safe paths.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// scoring/external/attn.mjs -> repo root is two dirs up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCORER_ID = "attn";
const SCORER_VERSION = "1";
const MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct";

// Char caps on the JS side (the Python side re-truncates by tokens — these are
// just to keep the temp JSON small and the spawn fast).
const TAIL_CHAR_CAP = 12_000;
const BLOCK_CHAR_CAP = 3_000;
const SPAWN_TIMEOUT_MS = 20 * 60 * 1000; // 20 min / tick

/** Resolve the probe's venv python, falling back to env PYTHON then "python". */
function resolvePython() {
	const venvPy = path.join(
		REPO_ROOT,
		"scoring",
		"probe",
		".venv",
		"Scripts",
		"python.exe",
	);
	if (fs.existsSync(venvPy)) return venvPy;
	if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) {
		return process.env.PYTHON;
	}
	return "python";
}

/** Cap a string to `cap` chars, keeping head + tail when it overflows. */
function capHeadTail(text, cap) {
	if (!text) return "";
	if (text.length <= cap) return text;
	const head = Math.floor(cap * 0.75);
	const tail = cap - head;
	return text.slice(0, head) + " … " + text.slice(text.length - tail);
}

/** Cap the tail keeping the NEWEST text (truncate from the front). */
function capTailNewest(text, cap) {
	if (!text) return "";
	if (text.length <= cap) return text;
	return text.slice(text.length - cap);
}

export default async function runAttn({ ticks, contexts }) {
	if (!ticks || !ticks.length || !contexts || !contexts.length) return;

	const tick = ticks[0];
	const ctx = contexts[0];
	if (!tick || !ctx) return;

	const blockIds = tick.blockIds || [];
	if (!blockIds.length) {
		tick.scorers[SCORER_ID] = { version: SCORER_VERSION, wallMs: 0, params: {} };
		tick.scores[SCORER_ID] = [];
		return;
	}

	// Build the scored-block payload: blocks [0, atBlock), aligned to blockIds.
	const scoredBlocks = ctx.blocks.slice(0, ctx.atBlock);
	const blocks = scoredBlocks.map((b) => ({
		id: b.id,
		text: capHeadTail(b.text || "", BLOCK_CHAR_CAP),
	}));
	const tail = capTailNewest(ctx.tailText || "", TAIL_CHAR_CAP);

	// ---- cache key: sha256(model + tailText + blockIds.join()) -----------
	const hash = crypto
		.createHash("sha256")
		.update(MODEL_ID)
		.update("\0")
		.update(tail)
		.update("\0")
		.update(blockIds.join(","))
		.digest("hex");

	const cacheDir = path.join(
		os.homedir(),
		".accordion",
		"relevance",
		"cache",
		SCORER_ID,
	);
	const cachePath = path.join(cacheDir, `${hash}.json`);

	let result = null;
	if (fs.existsSync(cachePath)) {
		try {
			result = JSON.parse(fs.readFileSync(cachePath, "utf8"));
		} catch {
			result = null; // corrupt cache — recompute
		}
	}

	if (!result) {
		// ---- spawn the probe ---------------------------------------------
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attn-"));
		const inPath = path.join(tmpDir, "in.json");
		const outPath = path.join(tmpDir, "out.json");

		fs.writeFileSync(inPath, JSON.stringify({ tail, blocks }), "utf8");

		const python = resolvePython();
		const probePy = path.join(REPO_ROOT, "scoring", "probe", "probe.py");

		const proc = spawnSync(
			python,
			[probePy, "--in", inPath, "--out", outPath],
			{
				cwd: REPO_ROOT,
				stdio: ["ignore", "inherit", "inherit"], // stream stderr progress
				timeout: SPAWN_TIMEOUT_MS,
				windowsHide: true,
			},
		);

		if (proc.error) {
			cleanup(tmpDir);
			throw new Error(`attn probe spawn failed: ${proc.error.message}`);
		}
		if (proc.status !== 0) {
			cleanup(tmpDir);
			throw new Error(`attn probe exited ${proc.status} (signal ${proc.signal})`);
		}
		if (!fs.existsSync(outPath)) {
			cleanup(tmpDir);
			throw new Error("attn probe produced no output file");
		}

		result = JSON.parse(fs.readFileSync(outPath, "utf8"));
		cleanup(tmpDir);

		// Persist to the content-addressed cache.
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cachePath, JSON.stringify(result), "utf8");
	}

	// ---- map scores onto the blockIds-aligned array ----------------------
	const scoreMap = (result && result.scores) || {};
	const aligned = blockIds.map((id) =>
		Object.prototype.hasOwnProperty.call(scoreMap, id) &&
		typeof scoreMap[id] === "number"
			? scoreMap[id]
			: null,
	);

	const meta = (result && result.meta) || {};
	tick.scorers[SCORER_ID] = {
		version: SCORER_VERSION,
		wallMs: typeof meta.wallMs === "number" ? meta.wallMs : undefined,
		params: meta.params || {},
	};
	tick.scores[SCORER_ID] = aligned;
}

function cleanup(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}
