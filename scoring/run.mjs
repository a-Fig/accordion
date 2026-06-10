/*
 * run.mjs — Relevance Lab harness.
 *
 * Usage:
 *   node scoring/run.mjs <path-to-session.jsonl> [--ticks N] [--final-only] [--out <path>]
 *
 * Reads a pi or Claude Code JSONL session, runs all registered pure scorers on
 * sampled ticks, and writes a ScoreFile JSON to --out or
 * %USERPROFILE%/.accordion/relevance/<sessionId>.scores.json.
 *
 * Bootstrapped with jiti exactly like extension/smoke.mjs.
 */
import { createJiti } from "jiti";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (!args.length || args[0].startsWith("--")) {
	console.error("Usage: node scoring/run.mjs <session.jsonl> [--ticks N] [--final-only] [--out <path>]");
	process.exit(1);
}

const sessionPath = args[0];
let maxTicks = 12;
let finalOnly = false;
let outPath = null;

for (let i = 1; i < args.length; i++) {
	if (args[i] === "--ticks" && args[i + 1]) {
		maxTicks = parseInt(args[++i], 10);
	} else if (args[i] === "--final-only") {
		finalOnly = true;
	} else if (args[i] === "--out" && args[i + 1]) {
		outPath = args[++i];
	}
}

if (!fs.existsSync(sessionPath)) {
	console.error(`Session file not found: ${sessionPath}`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// jiti bootstrap — mirrors extension/smoke.mjs pattern
// ---------------------------------------------------------------------------
const jiti = createJiti(import.meta.url);

// The scoring/ dir is one level below the repo root.
// parse.ts lives at ../app/src/lib/engine/parse.ts relative to scoring/.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_LIB = path.join(REPO_ROOT, "app", "src", "lib");

const parseMod = await jiti.import(path.join(APP_LIB, "engine", "parse.ts"));
const { parse } = parseMod;

const tailMod = await jiti.import(path.join(APP_LIB, "relevance", "tail.ts"));
const { sampleTicks } = tailMod;

const contextMod = await jiti.import(path.join(APP_LIB, "relevance", "context.ts"));
const { buildTickContext } = contextMod;

const scoreFileMod = await jiti.import(path.join(APP_LIB, "relevance", "scoreFile.ts"));
const { emptyTick, mergeScorerResult } = scoreFileMod;

const scorersMod = await jiti.import(path.join(APP_LIB, "relevance", "scorers", "index.ts"));
const { pureScorers } = scorersMod;

// ---------------------------------------------------------------------------
// Parse session
// ---------------------------------------------------------------------------
const raw = fs.readFileSync(sessionPath, "utf8");
const parsed = parse(raw);
const { blocks } = parsed;

const sessionId = path.basename(sessionPath, path.extname(sessionPath));
console.log(`Session: ${sessionId}  blocks: ${blocks.length}  format: ${parsed.meta.format}`);

// ---------------------------------------------------------------------------
// Compute tick endBlocks
// ---------------------------------------------------------------------------
const tickEndBlocks = finalOnly
	? [blocks.length]
	: sampleTicks(blocks, maxTicks);

console.log(`Ticks: ${tickEndBlocks.length}  (${finalOnly ? "final-only" : `sampled, maxTicks=${maxTicks}`})`);
console.log(`Pure scorers registered: ${pureScorers.length}`);

// ---------------------------------------------------------------------------
// Run scorers for each tick
// ---------------------------------------------------------------------------
const ticks = [];

for (let tickIdx = 0; tickIdx < tickEndBlocks.length; tickIdx++) {
	const endBlock = tickEndBlocks[tickIdx];
	const ctx = buildTickContext(blocks, endBlock);

	console.log(
		`  tick ${tickIdx}: endBlock=${endBlock} atBlock=${ctx.atBlock} ` +
		`scoredBlocks=${ctx.atBlock} tailBlocks=${endBlock - ctx.atBlock}`,
	);

	const tickScores = emptyTick(ctx, tickIdx);

	// Run each pure scorer and time it.
	for (const scorer of pureScorers) {
		const t0 = performance.now();
		let scores;
		try {
			scores = scorer.score(ctx);
		} catch (err) {
			console.warn(`    [${scorer.id}] ERROR: ${err.message}`);
			continue;
		}
		const wallMs = Math.round(performance.now() - t0);
		mergeScorerResult(tickScores, scorer.id, { version: scorer.version, wallMs }, scores);
		console.log(`    [${scorer.id}] v${scorer.version}  ${wallMs}ms  ${scores.filter((s) => s !== null).length} scored`);
	}

	// EXTERNAL SCORERS (embed/judge/attn/rerank) — wired by scoring/external/*.mjs as they land.
	// Each module default-exports: async ({ session, ticks, contexts, paths }) => void
	// that mutates TickScores in place.
	const externalModules = ["embed", "judge", "attn", "rerank"];
	for (const name of externalModules) {
		const modPath = path.join(REPO_ROOT, "scoring", "external", `${name}.mjs`);
		if (fs.existsSync(modPath)) {
			try {
				const extMod = await import(pathToFileURL(modPath).href);
				if (typeof extMod.default === "function") {
					await extMod.default({ session: parsed, ticks: [tickScores], contexts: [ctx], paths: { sessionPath, outPath } });
				}
			} catch (err) {
				console.log(`    [${name}] external module skipped: ${err.message}`);
			}
		}
		// Missing module: skip silently with a console note (only printed once, at startup)
	}

	ticks.push(tickScores);
}

// ---------------------------------------------------------------------------
// Assemble ScoreFile
// ---------------------------------------------------------------------------
const scoreFile = {
	version: 1,
	sessionId,
	generatedAt: new Date().toISOString(),
	ticks,
};

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
if (!outPath) {
	const relDir = path.join(os.homedir(), ".accordion", "relevance");
	fs.mkdirSync(relDir, { recursive: true });
	outPath = path.join(relDir, `${sessionId}.scores.json`);
}

const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(scoreFile, null, 2), "utf8");

console.log(`\nScore file written: ${outPath}`);
console.log(`  ticks: ${ticks.length}  scorers: ${Object.keys(ticks[0]?.scorers ?? {}).join(", ") || "(none)"}`);
