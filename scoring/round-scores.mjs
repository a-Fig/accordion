/*
 * round-scores.mjs — Round a ScoreFile's raw scores to 4 significant figures.
 *
 * Usage:
 *   node scoring/round-scores.mjs <input.scores.json> <output.json>
 *
 * Produces a copy of the score file with all numeric scores rounded to 4 sig-figs,
 * targeting < 1.5 MB for the shipped app bundle.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node scoring/round-scores.mjs <input.scores.json> <output.json>");
  process.exit(1);
}

const [inPath, outPath] = args;

if (!fs.existsSync(inPath)) {
  console.error(`Input not found: ${inPath}`);
  process.exit(1);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_LIB = path.join(REPO_ROOT, "app", "src", "lib");

const jiti = createJiti(import.meta.url);
const scoreFileMod = await jiti.import(path.join(APP_LIB, "relevance", "scoreFile.ts"));
const { validateScoreFile } = scoreFileMod;

// ---------------------------------------------------------------------------
// Round to N significant figures
// ---------------------------------------------------------------------------
function sigFig4(x) {
  if (x === null || x === undefined || typeof x !== "number" || !isFinite(x) || isNaN(x)) return x;
  if (x === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  const factor = Math.pow(10, 4 - d);
  return Math.round(x * factor) / factor;
}

// ---------------------------------------------------------------------------
// Load and validate
// ---------------------------------------------------------------------------
const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const validated = validateScoreFile(raw);
if (!validated) {
  console.error("Input does not pass ScoreFile validation.");
  process.exit(1);
}

console.log(`Input: ${inPath}`);
console.log(`  version=${raw.version}  sessionId=${raw.sessionId}  ticks=${raw.ticks.length}`);

// ---------------------------------------------------------------------------
// Round all scores in place (deep copy first)
// ---------------------------------------------------------------------------
const rounded = JSON.parse(JSON.stringify(raw));

let totalValues = 0;
let nullValues = 0;

for (const tick of rounded.ticks) {
  for (const [scorerId, scoreArr] of Object.entries(tick.scores ?? {})) {
    if (!Array.isArray(scoreArr)) continue;
    for (let i = 0; i < scoreArr.length; i++) {
      if (scoreArr[i] === null) { nullValues++; continue; }
      const orig = scoreArr[i];
      scoreArr[i] = sigFig4(orig);
      totalValues++;
    }
  }
}

// ---------------------------------------------------------------------------
// Validate output
// ---------------------------------------------------------------------------
const reValidated = validateScoreFile(rounded);
if (!reValidated) {
  console.error("Rounded output failed validation — aborting.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write output (compact JSON for smaller file)
// ---------------------------------------------------------------------------
const outDir = path.dirname(outPath);
if (outDir) fs.mkdirSync(outDir, { recursive: true });

// Write as minified JSON to minimize size
fs.writeFileSync(outPath, JSON.stringify(rounded), "utf8");

const sizeBytes = fs.statSync(outPath).size;
const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

console.log(`Output: ${outPath}`);
console.log(`  Size: ${sizeMB} MB (${sizeBytes} bytes)`);
console.log(`  Rounded values: ${totalValues}  Null values: ${nullValues}`);

if (sizeBytes > 1.5 * 1024 * 1024) {
  console.warn(`WARNING: output is ${sizeMB} MB, exceeds 1.5 MB target.`);
} else {
  console.log(`  OK: within 1.5 MB budget.`);
}

// Validate ticks count / structure
console.log(`  Ticks: ${rounded.ticks.length}  Scorers: ${Object.keys(rounded.ticks[0]?.scorers ?? {}).join(", ")}`);
